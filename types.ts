type PrivateLiquidatableResponseItem = {
  id: string,
  routes: string,
}

type PrivateLiquidatableResponse = {
  data: PrivateLiquidatableResponseItem[],
}

export {
    PrivateLiquidatableResponse,
    PrivateLiquidatableResponseItem,
}
