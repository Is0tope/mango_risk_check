# Mango Risk Check
This library provides an easy to use interface for the `mango_risk_check` Solana program. Read the [README](../README.md) for more information about the program itself.

## Instalation
Install via npm or yarn:
```
npm install mango_risk_check
// or
yarn add mango_risk_check
```

## Example
Check out [example.ts](examples/example.ts) for a full example.

```TypeScript
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
    tx.add(makeCancelAllPerpOrdersInstruction(/* ... */))
    tx.add(makePlacePerpOrder2Instruction(/* ... */))
    // VERY IMPORTANT!!! CheckRisk must be the last transaction
    tx.add(riskChecker.makeCheckRiskInstruction(perpMarketConfig,perpMarket))
    
    // Send the transaction
    await client.sendTransaction(tx, owner, [])

    // Get the current risk account
    console.log(await riskChecker.getRiskAccount(perpMarketConfig))

    // Close the risk account to get the SOL rent back
    await riskChecker.closeRiskAccount(perpMarketConfig)
```