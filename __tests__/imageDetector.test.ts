import {ImageDetector} from '../src/ImageDetector'

const imageDetector = new ImageDetector()

describe('Image Detector', () => {
  test('List all images', async () => {
    await imageDetector.getExistingImages()
  })
})
