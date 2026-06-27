export type OpenFileDialog = () => Promise<string>

export async function selectKeyPath(openFileDialog: OpenFileDialog, currentKeyPath: string): Promise<string> {
  const selected = await openFileDialog()
  return selected || currentKeyPath
}
