import * as core from '@actions/core'

import {CommandHelper} from './CommandHelper'

export class ImageDetector {
  async getExistingImages(): Promise<string[]> {
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
    const existingImages = new Set<string>()
    const output = await cmd.exec()
    const images = output.stdout.split('\n').filter(key => key !== ``)
    for (const image of images) {
      const [key, value] = image.split(' ')
      existingImages.add(key)
      existingImages.add(value)
    }

    return Array.from(existingImages)
  }

  async getImagesShouldSave(
    alreadyRegisteredImages: string[]
  ): Promise<string[]> {
    const resultSet = await this.getExistingImages()
    return resultSet.filter(item => alreadyRegisteredImages.indexOf(item) < 0)
  }
}
