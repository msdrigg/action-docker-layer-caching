import * as cache from '@actions/cache'
import * as core from '@actions/core'
import {promises as fs} from 'fs'

import {CommandExitCode, CommandHelper} from '../src/CommandHelper'
import {Events, RefKey} from '../src/constants'
import {ImageDetector} from '../src/ImageDetector'
import {LayerCache} from '../src/LayerCache'
import * as actionUtils from '../src/utils/actionUtils'
import * as testUtils from '../src/utils/testUtils'

const imageDetector = new ImageDetector()
jest.setTimeout(20000)
jest.mock('@actions/cache')
jest.mock('@actions/core')

beforeAll(() => {
  jest.spyOn(core, 'getInput').mockImplementation((name, options) => {
    return jest.requireActual('@actions/core').getInput(name, options)
  })
  jest.spyOn(actionUtils, 'getCacheState').mockImplementation(() => {
    return jest.requireActual('../src/utils/actionUtils').getCacheState()
  })
  jest
    .spyOn(actionUtils, 'isExactKeyMatch')
    .mockImplementation((key, cacheResult) => {
      return jest
        .requireActual('../src/utils/actionUtils')
        .isExactKeyMatch(key, cacheResult)
    })
  jest
    .spyOn(actionUtils, 'getInputAsArray')
    .mockImplementation((name, options) => {
      return jest
        .requireActual('../src/utils/actionUtils')
        .getInputAsArray(name, options)
    })
  jest.spyOn(actionUtils, 'isValidEvent').mockImplementation(() => {
    const actualUtils = jest.requireActual('../src/utils/actionUtils')
    return actualUtils.isValidEvent()
  })
})

beforeEach(() => {
  process.env[Events.Key] = Events.Push
  process.env[RefKey] = 'refs/heads/feature-branch'

  jest.spyOn(actionUtils, 'isGhes').mockImplementation(() => false)
})

afterEach(() => {
  testUtils.clearInputs()
  delete process.env[Events.Key]
  delete process.env[RefKey]
})

describe('Image Detector', () => {
  const dir = './__tests__/tmp'
  const savedCacheKey = 'Linux-node-bb828da54c148048dd17899ba9fda624811cfb43'
  const savedRestoreKeys = ['Linux-node-']

  test('Pull hello-world docker image', async () => {
    process.env.INPUT_FILTER = 'reference=hello-world*'
    const cmd = await new CommandHelper(
      process.cwd(),
      `docker pull hello-world`,
      undefined
    ).exec(true)
    expect(cmd.exitCode).toBe(CommandExitCode.SUCCESS)
    const imageList = await imageDetector.getExistingImages()
    expect(Object.values(imageList)[0]).toEqual('hello-world:latest')
  })
  test('Find and save hello-world image', async () => {
    process.env.INPUT_FILTER = 'reference=hello-world*'
    const result = await imageDetector.getExistingImages()
    expect(result['d1165f221234']).toStrictEqual('hello-world:latest')
    const imageList = [...Object.keys(result), ...Object.values(result)]
    await fs.mkdir(dir, {recursive: true})
    process.chdir(dir)
    const distinctImages = Array.from(new Set(imageList))
    core.info(distinctImages.join(','))

    const layerCache = new LayerCache(distinctImages)
    layerCache.concurrency = 10
    jest
      .spyOn(core, 'getState')
      // Cache Entry State
      .mockImplementationOnce(() => {
        return savedCacheKey
      })
      // Cache Key State
      .mockImplementationOnce(() => {
        return ''
      })
    const saveCacheMock = jest.spyOn(cache, 'saveCache')
    await layerCache.store(savedCacheKey)

    expect(saveCacheMock).toHaveBeenCalledTimes(1)

    const restoredKey = await layerCache.restore(
      savedCacheKey,
      savedRestoreKeys
    )
    await layerCache.cleanUp()
    core.info(`restored-key ${JSON.stringify(restoredKey || '')}`)
  })

  test('Find and restore hello-world image', async () => {
    process.env.INPUT_FILTER = 'reference=hello-world*'
    await fs.mkdir(dir, {recursive: true})
    process.chdir(dir)
    const distinctImages = ['d1165f221234', 'hello-world:latest']
    core.info(distinctImages.join(','))

    const layerCache = new LayerCache([])
    layerCache.concurrency = 10

    const restoredKey = await layerCache.restore(
      savedCacheKey,
      savedRestoreKeys
    )
    core.info(`restored-key ${JSON.stringify(restoredKey || '')}`)
  })
})
