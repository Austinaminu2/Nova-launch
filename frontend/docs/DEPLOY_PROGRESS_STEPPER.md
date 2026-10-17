# Deployment Progress Stepper

The deploy form shows each deployment phase as it happens, instead of a generic spinner:

| Step | What happens | Driven by |
| --- | --- | --- |
| **Build** | Uploads metadata to IPFS (if provided), then builds, prepares and simulates the transaction | `useTokenDeploy` / `StellarService.deployToken` `onProgress('build')` |
| **Sign** | The wallet signature request | `onProgress('sign')` |
| **Submit** | `sendTransaction` to Stellar RPC | `onProgress('submit')` |
| **Confirm** | Waits for the transaction to land in a ledger | `onProgress('confirm', txHash)`, then `useTransactionMonitor` (`pending` → `success`, or `failed`/`timeout`) |
| **Index** | Waits for the backend to index the token | Polls `GET /api/tokens/deployment-status/:txHash` every 2s until `CONFIRMED`. After 60s the step is marked *delayed*, not failed |

## Pieces

- `StellarService.deployToken(params, onProgress?)` emits `DeployProgressEvent`s.
- `useTokenDeploy` tracks `deployStep`, `failedStep`, `indexStatus` and `txHash`, starts
  `useTransactionMonitor` when the transaction is submitted, and exposes `monitorStatus` and
  `monitorProgress`.
- `utils/deploySteps.ts#deriveDeploySteps` is a pure function that maps that state to
  `upcoming | active | complete | failed | warning` for each step.
- `components/TokenDeployForm/DeploymentProgressStepper.tsx` renders the steps.

## Failure handling

When a step fails, the stepper marks it as failed and shows step-specific guidance
(`DEPLOY_STEP_RETRY_GUIDANCE`) next to a **Retry Deployment** button:

- **Build / Sign / Submit**: it's safe to retry once the cause is fixed (funding, wallet
  approval, fee balance).
- **Confirm**: the transaction may still land, so the panel links to the transaction in the
  explorer. Users can check it there before retrying, so they don't deploy the token twice.
- **Index**: the token is already live on-chain. A slow indexer is shown as a *delayed*
  warning with no retry, because re-deploying would create a duplicate.

Errors raised before deployment starts, such as validation or a missing wallet, still use the
existing error banner.

## Accessibility

- The current step has `aria-current="step"`.
- A polite live region announces step changes, failures and completion.
- Each step's state is exposed to screen readers as visually hidden text.
- The failure panel uses `role="alert"`.
- The active-step pulse respects `prefers-reduced-motion`.
