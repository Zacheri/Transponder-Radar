export class ReplayGate {
  rewound = false;
  private expectLive = false;

  enterReplay(): void {
    this.rewound = true;
  }

  requestLive(): void {
    this.expectLive = true;
  }

  /** Snapshot frames are always applied; the one answering requestLive() exits rewind. */
  onSnapshot(): boolean {
    if (this.expectLive) {
      this.expectLive = false;
      this.rewound = false;
    }
    return true;
  }

  onUpdate(): boolean {
    return !this.rewound;
  }
}
