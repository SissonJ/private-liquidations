import { config } from 'dotenv';
import {
  MsgExecuteContract,
 SecretNetworkClient, TxResponse, Wallet 
} from 'secretjs';
import { PrivateLiquidatableResponse } from './types';

config();

const client = new SecretNetworkClient({
  url: process.env.NODE!,
  chainId: process.env.CHAIN_ID!,
  wallet: new Wallet(process.env.ARB_V4!),
  walletAddress: process.env.WALLET_ADDRESS!,
  encryptionSeed: Uint8Array.from(process.env.ENCRYPTION_SEED!.split(',').map(Number)),
});
let lastRoute = 0;
let retry = 0;
let txHash: string | undefined = undefined;
const start = new Date().getTime();
const successfulLiquidations = 0;
const failedLiquidations = 0;
let totalAttempts = 0;

const getCentralTime = (date: Date): string => {
  return date.toLocaleString('en-US', {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).replace(/(\d+)\/(\d+)\/(\d+)/, '$3-$1-$2');
};

const logger = {
  error: (msg: string, time: Date, error?: any) => console.error(`[${getCentralTime(time)} ERROR] ${msg}`, error),
  info: (msg: string, time: Date) => console.log(`[${getCentralTime(time)} INFO] ${msg}`),
};

async function main() {
  const now = new Date();
  if ((now.getTime() - start > 7_200_000 && (now.getTime() - start) % 7_200_000 < 10_000) || now.getTime() - start < 15_000) {
    logger.info(`Bot running for ${Math.floor((now.getTime() - start) / 3600000)} hours, totalAttempts: ${totalAttempts}, successful: ${successfulLiquidations}, failed: ${failedLiquidations}`, now);
  }
  const response = await client.query.compute.queryContract<any, PrivateLiquidatableResponse>({
    contract_address: process.env.MONEY_MARKET_ADDRESS!,
    code_hash: process.env.MONEY_MARKET_HASH!,
    query: { private_liquidatable: {}, },
  });
  if (response.data.length > 0) {
    const liquidatable = response.data[lastRoute % response.data.length];
    try {
      let executeResponse: TxResponse | null = null; 
      if(txHash) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        executeResponse = await client.query.getTx(txHash);
      } else {
        logger.info(`ATTEMPTING - id: ${liquidatable.id} routes: liquidatable.routes`, now);
        totalAttempts += 1;
        executeResponse = await client.tx.broadcast([new MsgExecuteContract({ 
            sender: client.address, 
            contract_address: process.env.MONEY_MARKET_ADDRESS!,
            code_hash: process.env.MONEY_MARKET_HASH!,
            msg: {
               private_liquidate: {
                 account_id: String(liquidatable.id), 
                 route_index: String(lastRoute) 
              } 
            }, 
            sent_funds: [],
          })],
          {
            gasLimit: 1500000,
            feeDenom: "uscrt",
          },
        )
      }
      if(executeResponse === null) {
        throw new Error(`Transaction not found ${txHash}`);
      }
      if(executeResponse.code === 0) {
        logger.info(`LIQUIDATION ATTEMPT SUCCESSFUL - ${executeResponse.transactionHash}`, now);
        if(!executeResponse.arrayLog && !executeResponse.jsonLog) {
          txHash = executeResponse.transactionHash;
          throw new Error("Missing log - liquidate");
        }
        logger.info(JSON.stringify(executeResponse.arrayLog), now);
        logger.info(JSON.stringify(executeResponse.jsonLog), now);
        txHash = undefined;
      } else {
        if(executeResponse.rawLog === undefined || executeResponse.rawLog.length === 0) {
          txHash = executeResponse.transactionHash;
          throw new Error("Missing log");
        }
        logger.info(JSON.stringify(executeResponse.arrayLog), now);
        logger.info(JSON.stringify(executeResponse.jsonLog), now);
      }
      if(executeResponse.rawLog?.includes("incorrect account sequence")) {
        throw new Error("account sequence");
      }
      if(executeResponse.rawLog?.includes("out of gas")){
        throw new Error("out of gas");
      }
      retry = 0;
    } catch (e: any) {
      if(retry > 10) {
        retry = 0;
      } else {
        retry += 1;
        logger.error(e?.message, now);
      }
    }
    lastRoute = lastRoute + 1;
  }
}

console.log("PROCESS PID: ", process.pid);
setInterval(async () => {
  try{
    await main();
  } catch(e) {
    console.log('Error in setInterval');
    console.log(e);
  }
}, 10_000);

