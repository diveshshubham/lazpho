export class Ewma {
  private value: number | undefined;

  public constructor(private readonly alpha: number) {
    if (!Number.isFinite(alpha) || alpha <= 0 || alpha > 1) throw new RangeError('EWMA alpha must be greater than 0 and at most 1.');
  }

  public update(next: number): number {
    if (!Number.isFinite(next) || next < 0) throw new RangeError('EWMA values must be finite non-negative numbers.');
    this.value = this.value === undefined ? next : this.alpha * next + (1 - this.alpha) * this.value;
    return this.value;
  }

  public current(): number | undefined {
    return this.value;
  }
}
