import * as fs from 'fs';
import { config } from 'dotenv';
import {
  MsgExecuteContract,
  SecretNetworkClient, 
  TxResponse, 
  Wallet 
} from 'secretjs';
import {
 PrivateLiquidatableResponse, 
 State 
} from './types';

const CONSTANTS = {
  // Time constants (in milliseconds)
  STATUS_REPORT_INTERVAL: 7_200_000, // 2 hours
  INITIAL_REPORT_THRESHOLD: 15_000,   // 15 seconds
  ATTEMPT_COOLDOWN: 30_000,          // 30 seconds
  ONE_SECOND: 1_000,          // one second 
  ONE_HOUR: 3_600_000,          // one hour
  
  // Pagination
  PAGE_SIZE: 60,
  
  // Transaction settings
  GAS_LIMIT: 5_000_000,
  FEE_DENOM: 'uscrt',
  
  // Time format settings
  TIME_ZONE: 'America/Chicago',
  DATE_FORMAT: {
    timeZone: 'America/Chicago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }
} as const;

const getCentralTime = (date: Date): string => {
  return date.toLocaleString(
    'en-US', 
    CONSTANTS.DATE_FORMAT
  ).replace(
    /(\d+)\/(\d+)\/(\d+)/, 
    '$3-$1-$2'
  );
};

const logger = {
  error: (msg: string, time: Date, error?: any) => {
    console.error(`[${getCentralTime(time)} ERROR] ${msg}`, error);
  },
  info: (msg: string, time: Date) => {
    console.log(`[${getCentralTime(time)} INFO] ${msg}`);
  }
};

config();

if (!process.env.NODE 
    || !process.env.CHAIN_ID 
    || !process.env.ARB_V4 
    || !process.env.WALLET_ADDRESS 
    || !process.env.ENCRYPTION_SEED
    || !process.env.MONEY_MARKET_ADDRESS
    || !process.env.MONEY_MARKET_HASH
) {
  throw new Error("Missing environment variables");
}

const client = new SecretNetworkClient({
  url: process.env.NODE!,
  chainId: process.env.CHAIN_ID!,
  wallet: new Wallet(process.env.ARB_V4!),
  walletAddress: process.env.WALLET_ADDRESS!,
  encryptionSeed: Uint8Array.from(process.env.ENCRYPTION_SEED!.split(',').map(Number)),
});

async function main() {
  if (!fs.existsSync('./state.txt')) {
    const initialState: State = {
      totalAttempts: 0,
      successfulLiquidations: 0,
      failedLiquidations: 0,
      totalPages: 1,
      page: 0,
      txHash: undefined,
      attempts: {},
      blacklist: {}
    };
    fs.writeFileSync('./state.txt', JSON.stringify(initialState));
  }

  const stateUnparsed = fs.readFileSync('./state.txt', 'utf-8');
  const state: State = JSON.parse(stateUnparsed);

  const now = new Date();
  const start = state.start || now.getTime();
  if(state.start === undefined) {
    state.start = now.getTime();
  }
 if (state.start === undefined ||  now.getTime() - (state.lastUpdate ?? 0) > 7_200_000) {
    logger.info(
      `Bot running for ${Math.floor((now.getTime() - start) / CONSTANTS.ONE_HOUR)} hours\n` +
      `  Total Attempts: ${state.totalAttempts}\n` +
      `  Successful: ${state.successfulLiquidations}\n` +
      `  Failed: ${state.failedLiquidations}\n` +
      `  Average Query Length: ${state.queryLength?.toFixed(4)}`,
      now
    );
  }
  const beforeQuery = new Date().getTime();
  const response = await client.query.compute.queryContract<any, PrivateLiquidatableResponse>({
    contract_address: process.env.MONEY_MARKET_ADDRESS!,
    code_hash: process.env.MONEY_MARKET_HASH!,
    query: { 
      private_liquidatable: { 
        pagination: {
          page: state.page, 
          page_size: CONSTANTS.PAGE_SIZE,
        }
      }, 
    },
  });
  const queryLength = (new Date().getTime() - beforeQuery) / CONSTANTS.ONE_SECOND;
  state.queryLength = state.queryLength ? (state.queryLength + queryLength) / 2 : queryLength;
  state.totalPages = response.total_pages;
  state.page = (state.page + 1) % state.totalPages;

  const blacklist = Object.keys(state.blacklist);
  const blacklistedResponse = response.data.filter((log) => !blacklist.includes(log.id));

  if (blacklistedResponse.length > 0 ) {
    const liquidatable = blacklistedResponse[state.totalAttempts % blacklistedResponse.length];

    if(state.attempts[liquidatable.id] 
       && state.attempts[liquidatable.id] > now.getTime() - 30_000) {
      logger.info(`SKIPPING - id: ${liquidatable.id} 30 cooldown`, now);
      return;
    } else if(state.attempts[liquidatable.id]) {
      delete state.attempts[liquidatable.id];
    }
    state.attempts[liquidatable.id] = now.getTime();

    try {
      let executeResponse: TxResponse | null = null; 
      if(state.txHash) {
        executeResponse = await client.query.getTx(state.txHash);
      } else {
        logger.info(`ATTEMPTING - id: ${liquidatable.id} routes: ${liquidatable.routes}`, now);
        state.totalAttempts += 1;
        executeResponse = await client.tx.broadcast([new MsgExecuteContract({ 
            sender: client.address, 
            contract_address: process.env.MONEY_MARKET_ADDRESS!,
            code_hash: process.env.MONEY_MARKET_HASH!,
            msg: {
               private_liquidate: {
                 account_id: String(liquidatable.id), 
                 route_index: String(state.totalAttempts) 
              } 
            }, 
            sent_funds: [],
          })],
          {
            gasLimit: CONSTANTS.GAS_LIMIT,
            feeDenom: CONSTANTS.FEE_DENOM,
          },
        )
      }
      if(executeResponse === null) {
        throw new Error(`Transaction not found ${state.txHash}`);
      }
      if(executeResponse.code === 0) {
        state.successfulLiquidations += 1;
        logger.info(`LIQUIDATION ATTEMPT SUCCESSFUL - ${executeResponse.transactionHash}`, now);
        if(!executeResponse.arrayLog && !executeResponse.jsonLog) {
          state.txHash = executeResponse.transactionHash;
          throw new Error("Missing log - liquidate");
        }
        logger.info(JSON.stringify(executeResponse.arrayLog), now);
        logger.info(JSON.stringify(executeResponse.jsonLog), now);
        state.txHash = undefined;
      } else {
        if(executeResponse.rawLog === undefined || executeResponse.rawLog.length === 0) {
          state.txHash = executeResponse.transactionHash;
          throw new Error("Missing log");
        }
        state.failedLiquidations += 1;
        logger.info(JSON.stringify(executeResponse.arrayLog), now);
        logger.info(JSON.stringify(executeResponse.jsonLog), now);
      }
      if(executeResponse.rawLog?.includes("incorrect account sequence")) {
        throw new Error("account sequence");
      }
      if(executeResponse.rawLog?.includes("out of gas")){
        state.blacklist[liquidatable.id] = now.getTime();
        throw new Error("out of gas");
      }
      if(executeResponse.rawLog?.includes("contract panicked")){
        state.blacklist[liquidatable.id] = now.getTime();
        throw new Error("panic");
      }
    } catch (e: any) {
      logger.error(e?.message, now);
    }
  }
  blacklist.forEach((id) => {
    if(state.blacklist[id] < now.getTime() - 86_400_000) { // 24 hours
      delete state.blacklist[id];
    }
  });
  fs.writeFileSync('./state.txt', JSON.stringify(state, null, 2));
}

try {
  Promise.resolve(main());
} catch(error:any) {
  logger.error(error?.message, new Date());
}
