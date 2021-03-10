import * as cache from '@actions/cache'
import * as core from '@actions/core'
import crypto from 'crypto'
import {promises as fs} from 'fs'
import PromisePool from 'native-promise-pool'
import * as path from 'path'
import recursiveReaddir from 'recursive-readdir'
import format from 'string-format'

import {CommandHelper} from './CommandHelper'
import {loadManifests, loadRawManifests, Manifest, Manifests} from './Tar'

class LayerCache {
  ids: string[] = []
  unformattedSaveKey = ''
  restoredRootKey = ''
  imagesDir: string = path.join(__dirname, '..', '.adlc')
  enabledParallel = true
  concurrency = 4

  static ERROR_CACHE_ALREADY_EXISTS_STR = `Unable to reserve cache with key`
  static ERROR_LAYER_CACHE_NOT_FOUND_STR = `Layer cache not found`

  constructor(ids: string[]) {
    this.ids = ids
  }

  async store(key: string): Promise<boolean> {
    this.unformattedSaveKey = key

    await this.saveImageAsUnpacked()
    if (this.enabledParallel) {
      await this.separateAllLayerCaches()
    }

    if ((await this.storeRoot()) === undefined) {
      core.info(`cache key already exists, aborting.`)
      return false
    }

    await Promise.all(this.enabledParallel ? await this.storeLayers() : [])
    return true
  }

  private async saveImageAsUnpacked(): Promise<number> {
    await fs.mkdir(this.getUnpackedTarDir(), {recursive: true})
    const result = await new CommandHelper(this.getUnpackedTarDir(), 'bash', [
      '-c',
      `docker save '${(
        await this.makeRepotagsDockerSaveArgReady(this.ids)
      ).join(`' '`)}' | tar xf - -C .`
    ]).exec()
    return result.exitCode
  }

  private async makeRepotagsDockerSaveArgReady(
    repotags: string[]
  ): Promise<string[]> {
    const getMiddleIdsWithRepotag = async (id: string): Promise<string[]> => {
      return [id.replace(`'`, ``), ...(await this.getAllImageIdsFrom(id))]
    }
    return Array.from(
      new Set((await Promise.all(repotags.map(getMiddleIdsWithRepotag))).flat())
    )
  }

  private async getAllImageIdsFrom(repotag: string): Promise<string[]> {
    const result = await new CommandHelper(this.getUnpackedTarDir(), 'docker', [
      'history',
      '-q',
      repotag
    ]).exec()

    const historyIds = result.stdout
      .split(`\n`)
      .filter(id => id !== `<missing>` && id !== ``)
    return historyIds
  }

  private async getManifests(): Promise<Manifests> {
    return loadManifests(this.getUnpackedTarDir())
  }

  private async storeRoot(): Promise<number | undefined> {
    const rootKey = await this.generateRootSaveKey()
    const paths = [this.getUnpackedTarDir()]
    core.info(`Start storing root cache, key: ${rootKey}, dir: ${paths}`)
    const cacheId = await LayerCache.dismissError(
      cache.saveCache(paths, rootKey),
      LayerCache.ERROR_CACHE_ALREADY_EXISTS_STR,
      -1
    )
    core.info(`Stored root cache, key: ${rootKey}, id: ${cacheId}`)
    return cacheId !== -1 ? cacheId : undefined
  }

  private async separateAllLayerCaches(): Promise<void> {
    await this.moveLayerTarsInDir(
      this.getUnpackedTarDir(),
      this.getLayerCachesDir()
    )
  }

  private async joinAllLayerCaches(): Promise<void> {
    await this.moveLayerTarsInDir(
      this.getLayerCachesDir(),
      this.getUnpackedTarDir()
    )
  }

  private async moveLayerTarsInDir(
    fromDir: string,
    toDir: string
  ): Promise<void> {
    const layerTars = (await recursiveReaddir(fromDir))
      .filter(layerPath => path.basename(layerPath) === `layer.tar`)
      .map(layerPath => path.relative(fromDir, layerPath))

    const moveLayer = async (layer: string): Promise<void> => {
      const from = path.join(fromDir, layer)
      const to = path.join(toDir, layer)
      core.debug(`Moving layer tar from ${from} to ${to}`)
      await fs.mkdir(path.dirname(to), {recursive: true})
      await fs.rename(from, to)
    }
    await Promise.all(layerTars.map(moveLayer))
  }

  private async storeLayers(): Promise<number[]> {
    const pool = new PromisePool(this.concurrency)

    const result = Promise.all(
      (await this.getLayerIds()).map(async layerId => {
        return pool.open(async () => this.storeSingleLayerBy(layerId))
      })
    )
    return result
  }

  static async dismissError<T>(
    promise: Promise<T>,
    dismissStr: string,
    defaultResult: T
  ): Promise<T> {
    try {
      return await promise
    } catch (error) {
      if (error.name === cache.ValidationError.name) {
        throw error
      } else if (error.name === cache.ReserveCacheError.name) {
        core.info(error.message)
      } else {
        core.warning(error.message)
      }
      return defaultResult
    }
  }

  private async storeSingleLayerBy(layerId: string): Promise<number> {
    const layerPath = this.genSingleLayerStorePath(layerId)
    const key = await this.generateSingleLayerSaveKey(layerId)

    core.info(`Start storing layer cache: ${JSON.stringify({layerId, key})}`)
    const cacheId = await LayerCache.dismissError(
      cache.saveCache([layerPath], key),
      LayerCache.ERROR_CACHE_ALREADY_EXISTS_STR,
      -1
    )
    core.info(`Stored layer cache: ${JSON.stringify({key, cacheId})}`)

    core.debug(
      JSON.stringify({
        log: `storeSingleLayerBy`,
        layerId,
        layerPath,
        key,
        cacheId
      })
    )
    return cacheId
  }

  // ---

  async restore(
    primaryKey: string,
    restoreKeys?: string[]
  ): Promise<string | undefined> {
    const restoredCacheKey = await this.restoreRoot(primaryKey, restoreKeys)
    if (restoredCacheKey === undefined) {
      core.info(`Root cache could not be found. aborting.`)
      return undefined
    }
    if (this.enabledParallel) {
      const hasRestoredAllLayers = await this.restoreLayers()
      if (!hasRestoredAllLayers) {
        core.info(`Some layer cache could not be found. aborting.`)
        return undefined
      }
      await this.joinAllLayerCaches()
    }
    await this.loadImageFromUnpacked()
    return restoredCacheKey
  }

  private async restoreRoot(
    primaryKey: string,
    restoreKeys?: string[]
  ): Promise<string | undefined> {
    core.debug(
      `Trying to restore root cache: ${JSON.stringify({
        restoreKeys,
        dir: this.getUnpackedTarDir()
      })}`
    )
    const restoredRootKey = await cache.restoreCache(
      [this.getUnpackedTarDir()],
      primaryKey,
      restoreKeys
    )
    core.debug(`restoredRootKey: ${restoredRootKey}`)
    if (restoredRootKey === undefined) {
      return undefined
    }
    this.restoredRootKey = restoredRootKey

    return restoredRootKey
  }

  private async restoreLayers(): Promise<boolean> {
    const pool = new PromisePool(this.concurrency)
    const tasks = (await this.getLayerIds()).map(async layerId =>
      pool.open(async () => this.restoreSingleLayerBy(layerId))
    )

    try {
      await Promise.all(tasks)
    } catch (e) {
      if (
        typeof e.message === `string` &&
        e.message.includes(LayerCache.ERROR_LAYER_CACHE_NOT_FOUND_STR)
      ) {
        core.info(e.message)

        // Avoid UnhandledPromiseRejectionWarning
        for (const task of tasks) {
          try {
            core.error(await task)
          } catch (e2) {
            core.error(e2)
          }
        }

        return false
      }
      throw e
    }

    return true
  }

  private async restoreSingleLayerBy(id: string): Promise<string> {
    const layerPath = this.genSingleLayerStorePath(id)
    const key = await this.recoverSingleLayerKey(id)
    const dir = path.dirname(layerPath)

    core.debug(
      JSON.stringify({
        log: `restoreSingleLayerBy`,
        id,
        layerPath,
        dir,
        key
      })
    )

    await fs.mkdir(dir, {recursive: true})
    const result = await cache.restoreCache([layerPath], key)

    if (result == null) {
      throw new Error(
        `${LayerCache.ERROR_LAYER_CACHE_NOT_FOUND_STR}: ${JSON.stringify({
          id
        })}`
      )
    }

    return result
  }

  private async loadImageFromUnpacked(): Promise<void> {
    const cmd = new CommandHelper(this.getUnpackedTarDir(), `sh`, [
      '-c',
      'tar cf - . | docker load'
    ])
    await cmd.exec()
  }

  async cleanUp(): Promise<void> {
    await fs.rmdir(this.getImagesDir(), {recursive: true})
  }

  // ---

  getImagesDir(): string {
    return this.imagesDir
  }

  getUnpackedTarDir(): string {
    return path.join(this.getImagesDir(), this.getCurrentTarStoreDir())
  }

  getLayerCachesDir(): string {
    return `${this.getUnpackedTarDir()}-layers`
  }

  getCurrentTarStoreDir(): string {
    return 'image'
  }

  genSingleLayerStorePath(id: string): string {
    return path.join(this.getLayerCachesDir(), id, `layer.tar`)
  }

  async generateRootHashFromManifest(): Promise<string> {
    const manifest = await loadRawManifests(this.getUnpackedTarDir())
    return crypto.createHash(`sha256`).update(manifest, `utf8`).digest(`hex`)
  }

  async generateRootSaveKey(): Promise<string> {
    const rootHash = await this.generateRootHashFromManifest()
    const formatted = await this.getFormattedSaveKey(rootHash)
    core.debug(
      JSON.stringify({log: `generateRootSaveKey`, rootHash, formatted})
    )
    return `${formatted}-root`
  }

  async generateSingleLayerSaveKey(id: string): Promise<string> {
    const formatted = await this.getFormattedSaveKey(id)
    core.debug(
      JSON.stringify({log: `generateSingleLayerSaveKey`, formatted, id})
    )
    return `layer-${formatted}`
  }

  async recoverSingleLayerKey(id: string): Promise<string> {
    const unformatted = await this.recoverUnformattedSaveKey()
    return format(`layer-${unformatted}`, {hash: id})
  }

  async getFormattedSaveKey(hash: string): Promise<string> {
    const result = format(this.unformattedSaveKey, {hash})
    core.debug(JSON.stringify({log: `getFormattedSaveKey`, hash, result}))
    return result
  }

  async recoverUnformattedSaveKey(): Promise<string> {
    const hash = await this.generateRootHashFromManifest()
    core.debug(JSON.stringify({log: `recoverUnformattedSaveKey`, hash}))

    return this.restoredRootKey.replace(hash, `{hash}`).replace(/-root$/, ``)
  }

  async getLayerTarFiles(): Promise<string[]> {
    const getTarFilesFromManifest = (manifest: Manifest): string[] =>
      manifest.Layers

    const tarFilesThatMayDuplicate = (await this.getManifests()).flatMap(
      getTarFilesFromManifest
    )
    const tarFiles = [...new Set(tarFilesThatMayDuplicate)]
    return tarFiles
  }

  async getLayerIds(): Promise<string[]> {
    const layerIds = (await this.getLayerTarFiles()).map(layerFilePath =>
      path.dirname(layerFilePath)
    )
    core.debug(JSON.stringify({log: `getLayerIds`, layerIds}))
    return layerIds
  }
}

export {LayerCache}
