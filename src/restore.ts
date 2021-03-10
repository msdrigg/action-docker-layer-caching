import * as core from '@actions/core'

import {ImageDetector} from './ImageDetector'
import {LayerCache} from './LayerCache'

async function run(): Promise<void> {
  try {
    const primaryKey = core.getInput(`key`, {required: true})
    const restoreKeys = core
      .getInput(`restore-keys`, {required: false})
      ?.split(`\n`)
      .filter(key => key !== ``)

    const imageDetector = new ImageDetector()

    //* Get any existing images and tags from docker so we don't waste
    //  time restoring something thats already available

    const alreadyExistingImages = await imageDetector.getExistingImages()

    core.saveState(
      `already-existing-images`,
      JSON.stringify(alreadyExistingImages)
    )

    const layerCache = new LayerCache([])
    layerCache.concurrency = parseInt(
      core.getInput(`concurrency`, {required: true}),
      10
    )

    const restoredKey = await layerCache.restore(primaryKey, restoreKeys)
    await layerCache.cleanUp()

    core.saveState(`restored-key`, JSON.stringify(restoredKey || ''))
    core.saveState(
      `restored-images`,
      JSON.stringify(
        await imageDetector.getImagesShouldSave(alreadyExistingImages)
      )
    )
  } catch (e) {
    core.saveState(`restored-key`, JSON.stringify(``))
    core.saveState(`restored-images`, JSON.stringify([]))
    core.setFailed(e)
  }
}

run()
