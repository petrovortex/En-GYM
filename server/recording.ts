// A single audible 20 ms frame keeps a short answer eligible for normal grading.
export function silentRecording(pcm: Buffer, rate: number) {
  const frameBytes = Math.max(1, Math.round(rate * 0.02)) * 2
  for (let start = 0; start < pcm.length; start += frameBytes) {
    const end = Math.min(start + frameBytes, pcm.length)
    let energy = 0
    for (let i = start; i < end; i += 2) energy += pcm.readInt16LE(i) ** 2
    if (energy > ((end - start) / 2) * 32 ** 2) return false
  }
  return true
}

export const silentGrade = { score: 0, reviewed: true, note: '0/5. No audible response.' }
