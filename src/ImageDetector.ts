import * as core from '@actions/core'

import {CommandHelper} from './CommandHelper'

export interface dockerImage {
  [key: string]: string
}

export class ImageDetector {
  async getExistingImages(): Promise<dockerImage> {
    core.debug(`Existing Images:`)
    const _filter = core.getInput(`filter`)
    const filter = _filter ? `--filter=${_filter}` : ''
    const cmd = new CommandHelper(process.cwd(), `docker`, [
      'image',
      'ls',
      '--format={{.ID}} {{.Repository}}:{{.Tag}}',
      '--filter=dangling=false',
      filter
    ])
    const existingImages: dockerImage = {}
    const output = await cmd.exec()
    const images = output.stdout.split('\n').filter(key => key !== ``)
    for (const image of images) {
      const [key, value] = image.split(' ')
      existingImages[key] = value
    }

    return existingImages
  }

  async getImagesShouldSave(
    alreadyRegisteredImages: string[]
  ): Promise<string[]> {
    const resultSet = await this.getExistingImages()
    for (const image of alreadyRegisteredImages) {
      if (Object.prototype.hasOwnProperty.call(resultSet, image)) {
        delete resultSet.image
      }
    }
    return [...Object.keys(resultSet), ...Object.values(resultSet)]
  }
}
