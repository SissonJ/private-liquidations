type State = {
  start?: number,
  successfulLiquidations: number,
  failedLiquidations: number,
  totalAttempts: number,
  txHash: string | undefined,
  totalPages: number,
  queryLength?: number,
  page: number,
  attempts: {
    [key: string]: number, // <account_id>: <timestamp>
  },
}

type PrivateLiquidatableResponseItem = {
  id: string,
  routes: string,
}

type PrivateLiquidatableResponse = {
  total_pages: number,
  data: PrivateLiquidatableResponseItem[],
}

export {
  State,
  PrivateLiquidatableResponse,
  PrivateLiquidatableResponseItem,
}
