import { BN, Config, getMarketByBaseSymbolAndKind, getTokenAccountsByOwnerWithWrappedSol, getTokenByMint, getTokenBySymbol, GroupConfig, makeCancelAllPerpOrdersInstruction, makeConsumeEventsInstruction, makePlacePerpOrder2Instruction, MangoAccount, MangoClient, MangoGroup, PerpMarket, PublicKey, WalletAdapter, ZERO_BN } from '@blockworks-foundation/mango-client'
import { Connection, clusterApiUrl, Keypair, LAMPORTS_PER_SOL, Account, TransactionInstruction, Transaction } from '@solana/web3.js'
import { MangoRiskCheck, ViolationBehaviour } from '../lib'
import configFile from '@blockworks-foundation/mango-client/lib/src/ids.json'

// NOTE: Testing in devnet is not ideal due to non-determinism, however initially at least did not have time to learn to do/set up full mango set up. 
// This should be possible however, so will likely migrate in the future.

// Set a high timeout as devnet can be slow
jest.setTimeout(30_000)

function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const endpoint = clusterApiUrl('devnet')
const connection = new Connection(endpoint,'confirmed')
const wallet = Keypair.generate()
const deprecatedAccount = (wallet as unknown) as Account    // Hack required to work around deprecated Account on mango-client
const config = new Config(configFile)
const groupConfig = config.getGroupWithName('devnet.2') as GroupConfig
const client = new MangoClient(connection, groupConfig.mangoProgramId)
// Use SOL-PERP as testing wise this should be most stable with using native SOL as collateral
const perpConfig = getMarketByBaseSymbolAndKind(
    groupConfig,
    'SOL',
    'perp',
)
const I64_MAX_BN = new BN('9223372036854775807').toTwos(64);
const U64_MAX_BN = new BN('ffffffffffffffff',16);
let mangoAccount: MangoAccount
let mangoGroup: MangoGroup
let perpMarket: PerpMarket
let riskChecker: MangoRiskCheck
let bestBid: number
let bestAsk: number

beforeAll(async () => {
    // Get money
    await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL)
    await sleep(2000)

    // Create a Mango Account
    mangoGroup = await client.getMangoGroup(groupConfig.publicKey)
    const mangoAccountAddress = await client.createMangoAccount(mangoGroup,deprecatedAccount,0)
    await sleep(2000)
    mangoAccount = await client.getMangoAccount(
        mangoAccountAddress,
        mangoGroup.dexProgramId,
    )

    riskChecker = new MangoRiskCheck({
        owner: wallet,
        connection: connection,
        mangoAccount: mangoAccount,
        mangoClient: client,
        mangoGroup: mangoGroup
    })

    // Drop some cash in the testing account
    const tokenAccounts = await getTokenAccountsByOwnerWithWrappedSol(connection,wallet.publicKey)
    await mangoGroup.loadRootBanks(connection)
    const tokenIndex = mangoGroup.getTokenIndex(tokenAccounts[0].mint)
    const res = await client.deposit(
        mangoGroup,
        mangoAccount,
        deprecatedAccount,
        mangoGroup.tokens[tokenIndex].rootBank,
        mangoGroup.rootBankAccounts[tokenIndex]!.nodeBankAccounts[0].publicKey,
        mangoGroup.rootBankAccounts[tokenIndex]!.nodeBankAccounts[0].vault,
        tokenAccounts[0].publicKey,
        1.5
    )
    await sleep(2000)

    // Figure out best bid/ask for tests. This is very janky, but can't think of easier option in devnet
    perpMarket = await mangoGroup.loadPerpMarket(
        connection,
        perpConfig.marketIndex,
        perpConfig.baseDecimals,
        perpConfig.quoteDecimals,
    )

    const bids = await perpMarket.loadBids(connection);
    const asks = await perpMarket.loadAsks(connection);
    bestBid = bids.getBest()!.price
    bestAsk = asks.getBest()!.price
    console.log(`Symbol: SOL-PERP, bestBid: ${bestBid}, bestAsk: ${bestAsk}`)

})

// NOTE: These tests MUST be run in sequence as they are not independent!

test('initialising risk account creates an account with default params', async () => {

    await riskChecker.initializeRiskAccount(perpConfig)

    const newAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(newAcc.authority.toBase58()).toBe(wallet.publicKey.toBase58())
    expect(newAcc.marketIndex).toBe(perpConfig.marketIndex)
    expect(newAcc.maxLongExposure.eq(I64_MAX_BN)).toBe(true)
    expect(newAcc.maxShortExposure.eq(I64_MAX_BN)).toBe(true)
    expect(newAcc.maxOpenOrders.eq(U64_MAX_BN)).toBe(true)
    expect(newAcc.maxCapitalAllocated.eq(U64_MAX_BN)).toBe(true)
    expect(newAcc.violationBehaviour).toStrictEqual(riskChecker.mapViolationBehaviour(ViolationBehaviour.RejectTransaction))
})

test('Setting max open orders updates risk account', async () => {

    const tx = await riskChecker.setMaxOpenOrders(perpConfig,2)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.maxOpenOrders.toNumber()).toBe(2)
})


test('Placing open orders below maximum order limit is allowed', async () => {
    // Place orders deep in book
    const bidPrice = bestBid - 10
    const askPrice = bestAsk + 10

    await client.placePerpOrder2(mangoGroup,mangoAccount,perpMarket,deprecatedAccount,'buy',bidPrice,0.1)
    await client.placePerpOrder2(mangoGroup,mangoAccount,perpMarket,deprecatedAccount,'sell',askPrice,0.1)

    const openOrders = await perpMarket.loadOrdersForAccount(connection,mangoAccount)

    expect(openOrders.length).toBe(2)
})

test('Setting max open orders below open orders is rejected', async () => {
    const openOrders = await perpMarket.loadOrdersForAccount(connection,mangoAccount)
    expect(openOrders.length).toBe(2)
    return expect(riskChecker.setMaxOpenOrders(perpConfig,1))
        .rejects
        .toThrow('failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1770')
})

test('Placing another order in excess of max open orders rejects transaction', () => {
    const tx = new Transaction()
    tx.add(makePerpOrderInstruction('buy',bestBid - 10,0.1))
    tx.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))
    return expect(client.sendTransaction(tx, wallet, []))
        .rejects
        .toThrow('Transaction failed: AnchorError occurred. Error Code: NumOpenOrdersExceedsRiskLimit. Error Number: 6001. Error Message: Number of open orders exceeds risk limit.')
})

test('Setting max long exposure updates risk account', async () => {
    await riskChecker.setMaxLongExposure(perpConfig,perpMarket,0.5)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.maxLongExposure.toNumber()).toBe(50)

    await riskChecker.setMaxLongExposure(perpConfig,perpMarket,new BN(5000),true)
    const riskAcc2 = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc2.maxLongExposure.toNumber()).toBe(5000)
})

test('Acquiring position and orders below long exposure is permitted', async () => {

    await riskChecker.setMaxLongExposure(perpConfig,perpMarket,1)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.maxLongExposure.toNumber()).toBe(100)

    // Acquire a position by using aggressive order and place passive order up to limit
    const tx = new Transaction()
    tx.add(makeCancelAllInstruction())
    tx.add(makePerpOrderInstruction('buy',bestAsk + 10,0.7,'market'))
    tx.add(makePerpOrderInstruction('buy',bestBid - 10,0.3))
    tx.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    await client.sendTransaction(tx, wallet, [])

    expect((await perpMarket.loadFills(connection)).length).toBeGreaterThan(0)
    const openOrders2 = await perpMarket.loadOrdersForAccount(connection,mangoAccount)
    expect(openOrders2.length).toBe(1)

    // FIXME: Can't get the below to confirm the position reliably due to flakiness registering position.
    // Consume events to get the position up to date
    // await client.consumeEvents(mangoGroup,perpMarket,[mangoAccount.publicKey],deprecatedAccount,new BN(1000))

    // await mangoAccount.reload(connection) // Refresh position
    // const position = mangoAccount.getPerpPositionUi(perpConfig.marketIndex,perpMarket)
    // expect(position).toBe(0.7)
    // expect(openOrders2[0].size).toBeCloseTo(0.3,4)
})

test('Acquiring position and orders beyond long exposure is rejected', async() => {
    // NOTE: Already have a position of 0.7 here!

    await riskChecker.setMaxLongExposure(perpConfig,perpMarket,1)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.maxLongExposure.toNumber()).toBe(100)

    // Acquire a position by using aggressive order beyond the limit
    const tx = new Transaction()
    tx.add(makeCancelAllInstruction())
    tx.add(makePerpOrderInstruction('buy',bestAsk + 10,0.4,'market'))
    tx.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    await expect(client.sendTransaction(tx, wallet, []))
        .rejects
        .toThrow('Transaction failed: AnchorError occurred. Error Code: LongExposureExceedsRiskLimit. Error Number: 6003. Error Message: Long exposure exceeds risk limit.')
    
    // Place a long order beyond the limit
    const tx2 = new Transaction()
    tx2.add(makeCancelAllInstruction())
    tx2.add(makePerpOrderInstruction('buy',bestBid - 10,0.4))
    tx2.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    await expect(client.sendTransaction(tx2, wallet, []))
        .rejects
        .toThrow('Transaction failed: AnchorError occurred. Error Code: LongExposureExceedsRiskLimit. Error Number: 6003. Error Message: Long exposure exceeds risk limit.')
})

test('Setting max long exposure beyond risk limit rejects', async () => {
    // NOTE: Already have a position of 0.7 here!

    return expect(riskChecker.setMaxLongExposure(perpConfig,perpMarket,0.5)) // 0.7 > 0.5
        .rejects
        .toThrow('failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1772')
})

test('Setting max short exposure updates risk account', async () => {
    await riskChecker.setMaxShortExposure(perpConfig,perpMarket,0.5)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.maxShortExposure.toNumber()).toBe(50)

    await riskChecker.setMaxShortExposure(perpConfig,perpMarket,new BN(5000),true)
    const riskAcc2 = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc2.maxShortExposure.toNumber()).toBe(5000)
})


test('Acquiring position and orders below short exposure is permitted', async () => {

    await riskChecker.setMaxShortExposure(perpConfig,perpMarket,1)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.maxShortExposure.toNumber()).toBe(100)

    // Acquire a position by using aggressive order and place passive order up to limit
    const tx = new Transaction()
    tx.add(makeCancelAllInstruction())
    tx.add(makePerpOrderInstruction('sell',bestBid - 10,1.4,'market')) // Need to sell past the original 0.7 long position
    tx.add(makePerpOrderInstruction('sell',bestAsk + 10,0.3))
    tx.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    await client.sendTransaction(tx, wallet, [])

    expect((await perpMarket.loadFills(connection)).length).toBeGreaterThan(0)
    const openOrders2 = await perpMarket.loadOrdersForAccount(connection,mangoAccount)
    expect(openOrders2.length).toBe(1)
})

test('Acquiring position and orders beyond short exposure is rejected', async() => {
    // NOTE: Already have a position of -0.7 here!

    await riskChecker.setMaxShortExposure(perpConfig,perpMarket,1)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.maxShortExposure.toNumber()).toBe(100)

    // Acquire a position by using aggressive order beyond the limit
    const tx = new Transaction()
    tx.add(makeCancelAllInstruction())
    tx.add(makePerpOrderInstruction('sell',bestBid - 10,0.4,'market'))
    tx.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    await expect(client.sendTransaction(tx, wallet, []))
        .rejects
        .toThrow('Transaction failed: AnchorError occurred. Error Code: ShortExposureExceedsRiskLimit. Error Number: 6005. Error Message: Short exposure exceeds risk limit.')
    
    // Place a short order beyond the limit
    const tx2 = new Transaction()
    tx2.add(makeCancelAllInstruction())
    tx2.add(makePerpOrderInstruction('sell',bestAsk + 10,0.4))
    tx2.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    await expect(client.sendTransaction(tx2, wallet, []))
        .rejects
        .toThrow('Transaction failed: AnchorError occurred. Error Code: ShortExposureExceedsRiskLimit. Error Number: 6005. Error Message: Short exposure exceeds risk limit.')
})

test('Setting max short exposure beyond risk limit rejects', async () => {
    // NOTE: Already have a position of -0.7 here!

    return expect(riskChecker.setMaxShortExposure(perpConfig,perpMarket,0.5)) // 0.7 > 0.5
        .rejects
        .toThrow('failed to send transaction: Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1774')
})

test('Setting violation behaviour updates risk account', async () => {

    const tx = await riskChecker.setViolationBehaviour(perpConfig,ViolationBehaviour.CancelAllOrders)
    const riskAcc = await riskChecker.getRiskAccount(perpConfig)
    expect(riskAcc.violationBehaviour).toStrictEqual(riskChecker.mapViolationBehaviour(ViolationBehaviour.CancelAllOrders))
})

test('Violating short exposure with cancelAllOrders behaviour cancels all orders but does not reject', async () => {
    // NOTE: Already have a position of -0.7 here!

    await riskChecker.setViolationBehaviour(perpConfig,ViolationBehaviour.CancelAllOrders)
    await riskChecker.setMaxShortExposure(perpConfig,perpMarket,1)

    // Place a passive sell order below risk limit
    const tx = new Transaction()
    tx.add(makeCancelAllInstruction())
    tx.add(makePerpOrderInstruction('sell',bestAsk + 10,0.1))
    tx.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    let openOrders = await perpMarket.loadOrdersForAccount(connection,mangoAccount)
    expect(openOrders.length).toBe(1)

    // Place a short order beyond the limit
    const tx2 = new Transaction()
    tx2.add(makePerpOrderInstruction('sell',bestAsk + 10,0.4))
    tx2.add(riskChecker.makeCheckRiskInstruction(perpConfig,perpMarket))

    await expect(client.sendTransaction(tx2, wallet, []))

    await sleep(5_000) // TODO: Why is this needed? Seems like it doesn't appear to cancel right away? Find out why.
    openOrders = await perpMarket.loadOrdersForAccount(connection,mangoAccount)
    expect(openOrders.length).toBe(0)
})

test('Closing risk account returns SOL and removes the account', async () => {
    const prevBalance = await connection.getBalance(wallet.publicKey)
    await riskChecker.closeRiskAccount(perpConfig)
    const newBalance = await connection.getBalance(wallet.publicKey)
    expect(newBalance).toBeGreaterThan(prevBalance)
    await expect(riskChecker.getRiskAccount(perpConfig))
        .rejects
        .toThrow(new RegExp('Account does not exist .*'))
})

// Utils

function makeCancelAllInstruction(): TransactionInstruction {
    return makeCancelAllPerpOrdersInstruction(
        groupConfig.mangoProgramId,
        mangoGroup.publicKey,
        mangoAccount.publicKey,
        wallet.publicKey,
        perpMarket.publicKey,
        perpMarket.bids,
        perpMarket.asks,
        new BN(20)
    )
}

function makePerpOrderInstruction(side: 'buy' | 'sell', price: number, size: number, orderType: 'limit' | 'market' = 'limit'): TransactionInstruction {
    const [nativePrice, nativeQuantity] = perpMarket.uiToNativePriceQuantity(
        price,
        size,
    )
    return makePlacePerpOrder2Instruction(
        groupConfig.mangoProgramId,
        mangoGroup.publicKey,
        mangoAccount.publicKey,
        wallet.publicKey,
        mangoGroup.mangoCache,
        perpMarket.publicKey,
        perpMarket.bids,
        perpMarket.asks,
        perpMarket.eventQueue,
        mangoAccount.getOpenOrdersKeysInBasketPacked(),
        nativePrice,
        nativeQuantity,
        I64_MAX_BN,
        new BN(0),
        side,
        new BN(20),
        orderType,
        false,
        undefined,
        ZERO_BN,
      )
}