type State = {
  start?: number,
  successfulLiquidations: number,
  failedLiquidations: number,
  totalAttempts: number,
  txHash: string | undefined,
  attempts: {
    [key: string]: number, // <account_id>: <timestamp>
  },
}

type PrivateLiquidatableResponseItem = {
  id: string,
  routes: string,
}

type PrivateLiquidatableResponse = {
  data: PrivateLiquidatableResponseItem[],
}

export {
  State,
  PrivateLiquidatableResponse,
  PrivateLiquidatableResponseItem,
}
