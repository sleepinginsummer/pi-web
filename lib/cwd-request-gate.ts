export interface CwdRequestTicket {
  cwd: string;
  generation: number;
}

export class CwdRequestGate {
  private cwd: string | null = null;
  private generation = 0;

  setCwd(cwd: string | null): void {
    if (cwd === this.cwd) return;
    this.cwd = cwd;
    this.generation += 1;
  }

  begin(cwd: string): CwdRequestTicket {
    if (cwd !== this.cwd) return { cwd, generation: -1 };
    this.generation += 1;
    return { cwd, generation: this.generation };
  }

  isCurrent(ticket: CwdRequestTicket): boolean {
    return ticket.cwd === this.cwd && ticket.generation === this.generation;
  }
}
