import * as core from '@actions/core'
import {assertType} from 'typescript-is'

import {ImageDetector} from './ImageDetector'
import {LayerCache} from './LayerCache'

async function run(): Promise<void> {
  try {
    if (JSON.parse(core.getInput('skip-save', {required: true}))) {
      core.info('Skipping save.')
      return
    }

    const primaryKey = core.getInput('key', {required: true})

    const restoredKey: string = JSON.parse(core.getState(`restored-key`))
    const alreadyExistingImages: string[] = JSON.parse(
      core.getState(`already-existing-images`)
    )
    const restoredImages: string[] = JSON.parse(
      core.getState(`restored-images`)
    )

    assertType<string>(restoredKey)
    assertType<string[]>(alreadyExistingImages)
    assertType<string[]>(restoredImages)

    const imageDetector = new ImageDetector()

    const existingAndRestoredImages = alreadyExistingImages.concat(
      restoredImages
    )
    const newImages = await imageDetector.getImagesShouldSave(
      existingAndRestoredImages
    )

    if (newImages.length < 1) {
      core.info(`There is no image to save.`)
      return
    }

    const imagesToSave = await imageDetector.getImagesShouldSave(
      alreadyExistingImages
    )
    const layerCache = new LayerCache(imagesToSave)
    layerCache.concurrency = parseInt(
      core.getInput(`concurrency`, {required: true}),
      10
    )

    await layerCache.store(primaryKey)
    await layerCache.cleanUp()
  } catch (e) {
    core.setFailed(e)
  }
}

run()
