/**
 * MAZZ ÆNGENIUM — Machines à états finis fermées
 * 
 * Aucune transition non déclarée n'est tolérée par l'architecture.
 */

export type ComposerState = 'idle' | 'typing' | 'sending' | 'streaming';

export type ComposerEvent =
  | { type: 'INPUT'; text: string }
  | { type: 'CLEAR' }
  | { type: 'SUBMIT'; valid: boolean }
  | { type: 'STREAM_START' }
  | { type: 'STREAM_END' }
  | { type: 'ABORT' };

export class ComposerStateMachine {
  private _state: ComposerState = 'idle';

  get state(): ComposerState {
    return this._state;
  }

  transition(event: ComposerEvent): ComposerState {
    const current = this._state;
    switch (current) {
      case 'idle':
        if (event.type === 'INPUT' && event.text.length > 0) {
          this._state = 'typing';
        } else if (event.type === 'SUBMIT' && event.valid) {
          this._state = 'sending';
        }
        break;

      case 'typing':
        if (event.type === 'INPUT' && event.text.length === 0) {
          this._state = 'idle';
        } else if (event.type === 'CLEAR') {
          this._state = 'idle';
        } else if (event.type === 'SUBMIT' && event.valid) {
          this._state = 'sending';
        }
        break;

      case 'sending':
        if (event.type === 'STREAM_START') {
          this._state = 'streaming';
        } else if (event.type === 'ABORT' || event.type === 'STREAM_END') {
          this._state = 'idle';
        }
        break;

      case 'streaming':
        if (event.type === 'STREAM_END' || event.type === 'ABORT') {
          this._state = 'idle';
        }
        break;
    }

    if (this._state === current && event.type !== 'INPUT') {
      // Transition interdite ignorée ou rejetée
    }

    return this._state;
  }
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export type ApprovalEvent =
  | { type: 'APPROVE_ONCE' }
  | { type: 'APPROVE_ALWAYS'; scope: 'turn' | 'session' | 'project' }
  | { type: 'REJECT'; reason?: string }
  | { type: 'TIMEOUT' };

export class ApprovalStateMachine {
  private _state: ApprovalState = 'pending';

  get state(): ApprovalState {
    return this._state;
  }

  transition(event: ApprovalEvent): ApprovalState {
    if (this._state !== 'pending') {
      return this._state; // État terminal
    }

    switch (event.type) {
      case 'APPROVE_ONCE':
      case 'APPROVE_ALWAYS':
        this._state = 'approved';
        break;
      case 'REJECT':
        this._state = 'rejected';
        break;
      case 'TIMEOUT':
        this._state = 'expired';
        break;
    }

    return this._state;
  }
}
