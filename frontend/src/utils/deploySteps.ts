import type { DeployIndexStatus, DeployStepId } from '../types';

export type DeployStepState = 'upcoming' | 'active' | 'complete' | 'failed' | 'warning';

export type MonitorStatus = 'pending' | 'success' | 'failed' | 'timeout' | null;

export interface DeployStepView {
    id: DeployStepId;
    label: string;
    description: string;
    state: DeployStepState;
    /** Extra live detail for the active step (e.g. "Uploading metadata to IPFS"). */
    detail?: string;
}

export const DEPLOY_STEP_ORDER: DeployStepId[] = ['build', 'sign', 'submit', 'confirm', 'index'];

const STEP_COPY: Record<DeployStepId, { label: string; description: string }> = {
    build: { label: 'Build', description: 'Preparing and simulating the deployment transaction' },
    sign: { label: 'Sign', description: 'Approve the transaction in your wallet' },
    submit: { label: 'Submit', description: 'Sending the signed transaction to Stellar' },
    confirm: { label: 'Confirm', description: 'Waiting for the network to include the transaction in a ledger' },
    index: { label: 'Index', description: 'Making your token visible in Nova Launch' },
};

/**
 * Guidance shown when a step fails. Steps from `submit` onward may already
 * have reached the network, so the copy warns against blind retries that
 * could deploy the token twice.
 */
export const DEPLOY_STEP_RETRY_GUIDANCE: Record<DeployStepId, string> = {
    build:
        "We couldn't prepare the transaction. Check your connection and that your account is funded on the selected network, then retry.",
    sign:
        'The signature request was rejected or timed out. Unlock your wallet, approve the request, and retry.',
    submit:
        'The network rejected the transaction. Make sure your XLM balance covers the fees, then retry.',
    confirm:
        "The transaction wasn't confirmed in time. It may still succeed. Check it in the explorer before retrying so you don't deploy the token twice.",
    index:
        "Your token is live on-chain, but indexing is taking longer than usual. It will appear in your dashboard shortly. You don't need to deploy it again.",
};

export interface DeriveDeployStepsInput {
    /** Step the deployment most recently entered (null before it starts). */
    currentStep: DeployStepId | null;
    /** Step that was active when the deployment failed, if it failed. */
    failedStep: DeployStepId | null;
    /** `useTransactionMonitor` status for the submitted transaction. */
    monitorStatus?: MonitorStatus;
    /** `useTransactionMonitor` progress (0–100) for the confirm step. */
    monitorProgress?: number;
    indexStatus?: DeployIndexStatus;
    /** True while metadata is being uploaded to IPFS ahead of the build step. */
    uploadingMetadata?: boolean;
}

export function deriveDeploySteps({
    currentStep,
    failedStep,
    monitorStatus = null,
    monitorProgress,
    indexStatus = 'idle',
    uploadingMetadata = false,
}: DeriveDeployStepsInput): DeployStepView[] {
    const currentIndex = currentStep ? DEPLOY_STEP_ORDER.indexOf(currentStep) : uploadingMetadata ? 0 : -1;

    return DEPLOY_STEP_ORDER.map((id, i) => {
        const copy = STEP_COPY[id];
        let state: DeployStepState;

        if (failedStep === id) {
            state = 'failed';
        } else if (i < currentIndex) {
            state = 'complete';
        } else if (i === currentIndex) {
            state = failedStep ? 'upcoming' : 'active';
        } else {
            state = 'upcoming';
        }

        let detail: string | undefined;

        if (id === 'build' && state === 'active' && uploadingMetadata && !currentStep) {
            detail = 'Uploading metadata to IPFS';
        }

        // Confirm is driven by useTransactionMonitor events while it is the
        // active step; once the deployment has moved past it, the transaction
        // is known to be confirmed and late monitor events are ignored.
        if (id === 'confirm' && !failedStep && currentIndex === i) {
            if (monitorStatus === 'success') {
                state = 'complete';
            } else if (monitorStatus === 'failed' || monitorStatus === 'timeout') {
                state = 'failed';
            } else if (state === 'active' && typeof monitorProgress === 'number') {
                detail = `${Math.round(monitorProgress)}% of typical confirmation time`;
            }
        }

        if (id === 'index' && currentStep === 'index' && !failedStep) {
            if (indexStatus === 'indexed') state = 'complete';
            else if (indexStatus === 'delayed') state = 'warning';
        }

        return { id, ...copy, state, ...(detail ? { detail } : {}) };
    });
}
