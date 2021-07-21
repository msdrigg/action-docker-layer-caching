import * as core from '@actions/core'

import {ImageDetector} from './ImageDetector'
import {LayerCache} from './LayerCache'

async function run(): Promise<void> {
  try {
    if (JSON.parse(core.getInput('skip-save', {required: true}))) {
      core.info('Skipping save.')
      return
    }

    const primaryKey = core.getInput('key', {required: true})

    const alreadyExistingImages: string[] = JSON.parse(
      core.getState(`already-existing-images`)
    )

    const imageDetector = new ImageDetector()

    const imagesToSave = await imageDetector.getImagesShouldSave(
      alreadyExistingImages
    )

    if (imagesToSave.length < 1) {
      core.info(`There is no image to save.`)
      return
    }
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
