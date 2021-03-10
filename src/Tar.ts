import {promises as fs} from 'fs'
import * as path from 'path'

export interface Manifest {
  Config: string
  RepoTags: string[] | null
  Layers: string[]
}

export type Manifests = Manifest[]

export async function loadRawManifests(rootPath: string): Promise<string> {
  return (await fs.readFile(path.join(rootPath, `manifest.json`))).toString()
}

export async function loadManifests(manifestPath: string): Promise<Manifests> {
  const raw = await loadRawManifests(manifestPath)
  const manifests = JSON.parse(raw.toString())
  return manifests
}
