/** Copy text; falls back to a hidden textarea where the async clipboard API is unavailable. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try {
      return document.execCommand('copy')
    } catch {
      return false
    } finally {
      ta.remove()
    }
  }
}
