import * as os from 'os';
import * as fs from 'fs';
import { BN, Config, getMarketByBaseSymbolAndKind, GroupConfig, makeCancelAllPerpOrdersInstruction, makePlacePerpOrder2Instruction, MangoClient, ZERO_BN } from '@blockworks-foundation/mango-client'
import configFile from '@blockworks-foundation/mango-client/lib/src/ids.json'
import { Connection, Commitment, Keypair, Transaction } from '@solana/web3.js'
import { MangoRiskCheck, ViolationBehaviour } from '../lib'

const I64_MAX_BN = new BN('9223372036854775807').toTwos(64);

function readKeypair() {
    return JSON.parse(
      process.env.KEYPAIR ||
        fs.readFileSync(os.homedir() + '/.config/solana/devnet.json', 'utf-8'),
    );
}

async function example() {
    // setup client
    const config = new Config(configFile)
    const groupConfig = config.getGroupWithName('devnet.2') as GroupConfig
    const connection = new Connection(
    config.cluster_urls[groupConfig.cluster],
        'processed' as Commitment,
    )
    const client = new MangoClient(connection, groupConfig.mangoProgramId)

    // load group & market
    const perpMarketConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
        'SOL',
        'perp',
    )
    const mangoGroup = await client.getMangoGroup(groupConfig.publicKey)
    const perpMarket = await mangoGroup.loadPerpMarket(
    connection,
        perpMarketConfig.marketIndex,
        perpMarketConfig.baseDecimals,
        perpMarketConfig.quoteDecimals,
    )

    const owner = new Keypair(readKeypair())
    const mangoAccount = (await client.getMangoAccountsForOwner(mangoGroup, owner.publicKey))[0]

    // Create the risk checker
    const riskChecker = new MangoRiskCheck({
        connection: connection,
        mangoAccount: mangoAccount,
        mangoClient: client,
        mangoGroup: mangoGroup,
        owner: owner,
        // programID: new PublicKey('94oHQMrCECP266YUoQmDvgVwafZApP9KAseMyNtjAPP7') // can provide a custom programID
    })

    // Create a risk params account for our perp market
    await riskChecker.initializeRiskAccount(perpMarketConfig)

    // Set the maximum number of open orders
    await riskChecker.setMaxOpenOrders(perpMarketConfig, 10)

    // Set the maximum long exposure in UI units
    await riskChecker.setMaxLongExposure(perpMarketConfig,perpMarket,5.5) // Maximum long position of 5.5 SOL

    // Set the above, but using native units
    await riskChecker.setMaxLongExposure(perpMarketConfig,perpMarket,new BN(550),true)

    // Set the maximum short exposure in UI units
    await riskChecker.setMaxShortExposure(perpMarketConfig,perpMarket,3.5) // Maximum short position of 3.5 SOL

    // Set the violation behaviour. This is what the program will do if there is a risk violation
    //   RejectTransaction: Rejects the whole transaction
    //   CancelAllOrders:   Tries to cancel all the orders if this would reduce the risk below the limit, otherwise reject
    await riskChecker.setViolationBehaviour(perpMarketConfig,ViolationBehaviour.CancelAllOrders)

    // All instructions are available for composition
    const instruction = riskChecker.makeSetViolationBehaviourInstruction(perpMarketConfig,ViolationBehaviour.CancelAllOrders)

    // How to compose a cancel all an order and a risk check
    const tx = new Transaction()
    tx.add(makeCancelAllPerpOrdersInstruction(
        groupConfig.mangoProgramId,
        mangoGroup.publicKey,
        mangoAccount.publicKey,
        owner.publicKey,
        perpMarket.publicKey,
        perpMarket.bids,
        perpMarket.asks,
        new BN(20)
    ))
    tx.add(makePlacePerpOrder2Instruction(
        groupConfig.mangoProgramId,
        mangoGroup.publicKey,
        mangoAccount.publicKey,
        owner.publicKey,
        mangoGroup.mangoCache,
        perpMarket.publicKey,
        perpMarket.bids,
        perpMarket.asks,
        perpMarket.eventQueue,
        mangoAccount.getOpenOrdersKeysInBasketPacked(),
        new BN(100),
        new BN(10),
        I64_MAX_BN,
        new BN(0),
        'buy',
        new BN(20),
        'limit',
        false,
        undefined,
        ZERO_BN,
    ))
    // VERY IMPORTANT!!!
    // CheckRisk must be the last transaction
    tx.add(riskChecker.makeCheckRiskInstruction(perpMarketConfig,perpMarket))
    
    // Send the transaction
    await client.sendTransaction(tx, owner, [])

    // Get the current risk account
    console.log(await riskChecker.getRiskAccount(perpMarketConfig))

    // Close the risk account to get the SOL rent back
    await riskChecker.closeRiskAccount(perpMarketConfig)
}

example()