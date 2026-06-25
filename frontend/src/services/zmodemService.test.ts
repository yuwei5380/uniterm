import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockAppendFileBase64,
  mockOpenDirectoryDialog,
  mockSessionEndZmodem,
  mockSessionWrite,
  mockSessionWriteBinary,
  mockWriteFileBase64,
  sentryInstances,
} = vi.hoisted(() => {
  const sentryInstances: any[] = []
  return {
    mockAppendFileBase64: vi.fn().mockResolvedValue(undefined),
    mockOpenDirectoryDialog: vi.fn().mockResolvedValue('C:\\Downloads'),
    mockSessionEndZmodem: vi.fn().mockResolvedValue(undefined),
    mockSessionWrite: vi.fn().mockResolvedValue(undefined),
    mockSessionWriteBinary: vi.fn().mockResolvedValue(undefined),
    mockWriteFileBase64: vi.fn().mockResolvedValue(undefined),
    sentryInstances,
  }
})

vi.mock('zmodem.js/src/zmodem_browser', () => ({
  default: {
    Sentry: vi.fn(function (this: any, options) {
      sentryInstances.push(options)
      this.consume = vi.fn()
    }),
  },
}))

vi.mock('../../wailsjs/runtime', () => ({
  EventsOn: vi.fn(() => () => {}),
}))

vi.mock('../../wailsjs/go/main/App', () => ({
  AppendFileBase64: mockAppendFileBase64,
  OpenDirectoryDialog: mockOpenDirectoryDialog,
  OpenMultipleFilesDialog: vi.fn(),
  ReadFileBase64: vi.fn(),
  SessionEndZmodem: mockSessionEndZmodem,
  SessionWrite: mockSessionWrite,
  SessionWriteBinary: mockSessionWriteBinary,
  WriteFileBase64: mockWriteFileBase64,
}))

const mockStore = {
  addTransfer: vi.fn(),
  updateTransfer: vi.fn(),
  getPendingUploadFiles: vi.fn(),
}

vi.mock('../stores/zmodemStore', () => ({
  useZmodemStore: vi.fn(() => mockStore),
}))

import { startZmodemService } from './zmodemService'

describe('startZmodemService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sentryInstances.length = 0
    mockOpenDirectoryDialog.mockResolvedValue('C:\\Downloads')
  })

  it('streams sz download chunks to disk without buffering the full file', async () => {
    vi.useFakeTimers()
    const chunks = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5]),
    ]
    let offerHandler: ((offer: any) => void | Promise<void>) | undefined
    const offer = {
      get_details: () => ({ name: 'large.bin', size: 5 }),
      accept: vi.fn(async (options?: { on_input?: (payload: number[]) => void }) => {
        options?.on_input?.(Array.from(chunks[0]))
        options?.on_input?.(Array.from(chunks[1]))
      }),
      skip: vi.fn(),
    }
    const zsession = {
      type: 'receive',
      on: vi.fn((event: string, handler: (offer: any) => void | Promise<void>) => {
        if (event === 'offer') offerHandler = handler
      }),
      start: vi.fn(async () => {
        await offerHandler?.(offer)
      }),
      abort: vi.fn(),
      close: vi.fn(),
    }
    const onComplete = vi.fn()
    startZmodemService({ sessionId: 's1', onComplete })

    sentryInstances[0].on_detect({ confirm: () => zsession })
    await Promise.resolve()
    await Promise.resolve()

    await vi.runOnlyPendingTimersAsync()
    vi.useRealTimers()

    expect(offer.accept).toHaveBeenCalledWith({ on_input: expect.any(Function) })
    expect(mockAppendFileBase64).toHaveBeenCalledTimes(2)
    expect(mockAppendFileBase64).toHaveBeenNthCalledWith(1, 'C:\\Downloads\\large.bin', 'AQID', 0)
    expect(mockAppendFileBase64).toHaveBeenNthCalledWith(2, 'C:\\Downloads\\large.bin', 'BAU=', 3)
    expect(mockWriteFileBase64).not.toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith(['C:\\Downloads\\large.bin'])
    expect(mockSessionEndZmodem).toHaveBeenCalledWith('s1')
  })
})
