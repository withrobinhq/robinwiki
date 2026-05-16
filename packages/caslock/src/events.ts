export const CasLockEvents = {
  acquired: 'acquired',
  stolen: 'stolen',
  contended: 'contended',
  released: 'released',
  renewed: 'renewed',
  renewFailed: 'renewFailed',
  error: 'error',
} as const

export type CasLockEventName = (typeof CasLockEvents)[keyof typeof CasLockEvents]

export interface AcquiredEvent {
  key: string
  lockedBy: string
  fromState: string | string[]
  toState: string
}

export interface StolenEvent {
  key: string
  prevLockedBy: string
  lockedBy: string
}

export interface ContendedEvent {
  key: string
  fromState: string | string[]
}

export interface ReleasedEvent {
  key: string
  toState: string
}

export interface RenewedEvent {
  key: string
  newExpiresAt: Date
}

export interface RenewFailedEvent {
  key: string
  reason: string
}

export interface CasLockEventMap {
  acquired: [AcquiredEvent]
  stolen: [StolenEvent]
  contended: [ContendedEvent]
  released: [ReleasedEvent]
  renewed: [RenewedEvent]
  renewFailed: [RenewFailedEvent]
  error: [Error]
}
