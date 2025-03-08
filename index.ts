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
  error: (msg: string, time: Date, error?: any) => {
    console.error(`[${getCentralTime(time)} ERROR] ${msg}`, error);
  },
  info: (msg: string, time: Date) => {
    console.log(`[${getCentralTime(time)} INFO] ${msg}`);
  }
};

config();

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
      attempts: {}
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
 if ((now.getTime() - start > 7_200_000 
    && (now.getTime() - start) % 7_200_000 < 10_000) 
    || now.getTime() - start < 15_000
  ) {
    logger.info(`Bot running for ${Math.floor((now.getTime() - start) / 3600000)} hours, totalAttempts: ${state.totalAttempts}, successful: ${state.successfulLiquidations}, failed: ${state.failedLiquidations}, average query length: ${state.queryLength?.toFixed(4)}`, now);
  }
  const beforeQuery = new Date().getTime();
  const response = await client.query.compute.queryContract<any, PrivateLiquidatableResponse>({
    contract_address: process.env.MONEY_MARKET_ADDRESS!,
    code_hash: process.env.MONEY_MARKET_HASH!,
    query: { 
      private_liquidatable: { 
        pagination: {
          page: state.page, 
          page_size: 10,
        }
      }, 
    },
  });
  const queryLength = (new Date().getTime() - beforeQuery) / 1000;
  state.queryLength = state.queryLength ? (state.queryLength + queryLength) / 2 : queryLength;
  state.totalPages = response.total_pages;
  state.page = (state.page + 1) % state.totalPages;
  if (response.data.length > 0) {
    const liquidatable = response.data[state.totalAttempts % response.data.length];

    if(state.attempts[liquidatable.id] && state.attempts[liquidatable.id] > now.getTime() - 30_000) {
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
            gasLimit: 4000000,
            feeDenom: "uscrt",
          },
        )
      }
      if(executeResponse === null) {
        throw new Error(`Transaction not found ${state.txHash}`);
      }
      if(executeResponse.code === 0) {
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
        logger.info(JSON.stringify(executeResponse.arrayLog), now);
        logger.info(JSON.stringify(executeResponse.jsonLog), now);
      }
      if(executeResponse.rawLog?.includes("incorrect account sequence")) {
        throw new Error("account sequence");
      }
      if(executeResponse.rawLog?.includes("out of gas")){
        throw new Error("out of gas");
      }
    } catch (e: any) {
      logger.error(e?.message, now);
    }
  }
  fs.writeFileSync('./state.txt', JSON.stringify(state));
}

Promise.resolve(main());
