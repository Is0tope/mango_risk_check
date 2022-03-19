# mango_risk_check
Solana program to risk check transactions on Mango Markets.

## Purpose
Solana transactions are atomic, meaning that if any one of the instructions in a transaction fails, the whole transaction is rolled back. When sending multiple cancel, new order, etc transactions to the exchange, it is desirable to make sure that eg. you never acquire a larger position that you want (limit risk). This program allows you to set risk parameters such as the maximum position, and then add an additional instruction that checks whether the transaction would breach the risk limits. If it does, then the program will reject the transaction, or act so as to limit the risk.

## Supported Risk Limits
| Risk Limit | Default | Description |
| --- | --- | --- |
| max_open_orders | MAX_U64 | Maximum number of open orders on the exchange |
| max_long_exposure | MAX_U64 | Maximum long exposure (position + total long orders) permitted |
| max_short_exposure | MAX_U64 | Maximum short exposure (position + total short orders) permitted |

*More limits are planned.

## Deployment
The program is currently only deployed on `devnet`. The programID is `94oHQMrCECP266YUoQmDvgVwafZApP9KAseMyNtjAPP7`.
## How To Use
The first step is to initialise the risk_params_account PDA, which contains all of the risk limits **per instrument**. Currently, risk checks are limited in scope to each symbol individually. The address of the risk_params_account is a PDA derived from the following seeds:

```
seeds = ["risk-check", marketIndex as u8, Owner PublicKey]
```

The [initialize](#initialize) instruction can then be used to initialize the account. Individual risk limits can then be set using the [setter instructions](#available-instructions). In addition, the behaviour of the program when a risk limit is violated can be set using the [setViolationBehaviour](#setviolationbehaviour) instruction. Currently, this is either a full rejection of the transaction or the cancellation of any open orders on that symbol if it will reduce the risk. Attempting to set a risk limit that is currently breached is not currently permitted.

In order for the risk checker to work, the [checkRisk](#checkrisk) instruction must be placed as the **last instruction in the transaction**. This is important, as the risk check needs to see the outcome of all of the initial instructions first, in order to assess if they were permitted. If the checkRisk instruction fails, it means that all of the prior instructions get rolled back. For instance, the following would be an example set up (pseudo javascript):

```
const tx = new Transaction()
tx.add(new CancelAllOrdersInstruction())
tx.add(new PlaceBuyOrderInstruction())
tx.add(new PlaceSellOrderInstruction())
tx.add(new CheckRiskInstruction())
send(tx)
```

## Testing
The JavaScript API has a test suite that runs tests against `devnet`.

## Available Instructions

### initialize
Initialise a risk params account for a specific symbol. See [here](#how-to-use) for how to create the PDA.

#### Accounts
|       name      |isMut|isSigner|
|-----------------|-----|--------|
|    authority    | True|  True  |
|riskParamsAccount| True|  False |
|  systemProgram  |False|  False |

#### Arguments
|    name   |type|
|-----------|----|
|marketIndex| u8 |

### setMaxOpenOrders
Set the maximum number of open orders allowed.

#### Accounts
|       name      |isMut|isSigner|
|-----------------|-----|--------|
|    authority    |False|  True  |
|riskParamsAccount| True|  False |
|   mangoProgram  |False|  False |
|   mangoAccount  |False|  False |
|    mangoGroup   |False|  False |
#### Arguments
|     name    |type|
|-------------|----|
|maxOpenOrders| u64|

### setMaxLongExposure
Set the maximum long exposure allowed.

#### Accounts
|       name      |isMut|isSigner|
|-----------------|-----|--------|
|    authority    |False|  True  |
|riskParamsAccount| True|  False |
|   mangoProgram  |False|  False |
|   mangoAccount  |False|  False |
|    mangoGroup   |False|  False |
#### Arguments
|      name     |type|
|---------------|----|
|maxLongExposure| i64|

### setMaxShortExposure
Set the maximum short exposure allowed.

#### Accounts
|       name      |isMut|isSigner|
|-----------------|-----|--------|
|    authority    |False|  True  |
|riskParamsAccount| True|  False |
|   mangoProgram  |False|  False |
|   mangoAccount  |False|  False |
|    mangoGroup   |False|  False |
#### Arguments
|      name      |type|
|----------------|----|
|maxShortExposure| i64|

### setViolationBehaviour
Set the behaviour of the program when a risk check is violated. The following options are available:
| Name | Representation (u8) | Description |
| --- | --- | --- |
| RejectTransaction | 0 | Reject the entire transaction outright |
| CancelAllOrders | 1 | Cancel all orders if this will drop the exposure below the risk limit, otherwise reject |

#### Accounts
|       name      |isMut|isSigner|
|-----------------|-----|--------|
|    authority    |False|  True  |
|riskParamsAccount| True|  False |
|   mangoProgram  |False|  False |
|   mangoAccount  |False|  False |
|    mangoGroup   |False|  False |
#### Arguments
|       name       |               type              |
|------------------|---------------------------------|
|violationBehaviour| u8 |

### close
Close the risk params account, and return the SOL back to the `authority` account.

#### Accounts
|       name      |isMut|isSigner|
|-----------------|-----|--------|
|    authority    | True|  True  |
|riskParamsAccount| True|  False |
|  systemProgram  |False|  False |

### checkRisk
Check the current risk vs. the risk limits. This instruction should be added to all risk checkable transactions **as the last instruction**.

#### Accounts
|       name      |isMut|isSigner|
|-----------------|-----|--------|
|    authority    |False|  True  |
|riskParamsAccount| True|  False |
|   mangoProgram  |False|  False |
|   mangoAccount  |False|  False |
|    mangoGroup   |False|  False |
|    perpMarket   |False|  False |
|  perpMarketBids |False|  False |
|  perpMarketAsks |False|  False |

