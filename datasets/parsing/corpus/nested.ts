export class Outer {
  readonly name: string = 'outer';

  inner(): number {
    function helper(x: number): number {
      return x * 2;
    }
    return helper(21);
  }

  static make(): Outer {
    return new Outer();
  }
}

export namespace Shapes {
  export interface Box {
    width: number;
  }
}
