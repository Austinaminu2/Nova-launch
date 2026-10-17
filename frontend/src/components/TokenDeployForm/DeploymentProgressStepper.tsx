import type { DeployStepId } from '../../types';
import { DEPLOY_STEP_RETRY_GUIDANCE, type DeployStepView } from '../../utils/deploySteps';
import { getTxUrl } from '../../utils/explorer';

interface DeploymentProgressStepperProps {
    steps: DeployStepView[];
    network: 'testnet' | 'mainnet';
    txHash?: string | null;
    /** Error message from the failed step, shown alongside the retry guidance. */
    errorMessage?: string;
    onRetry?: () => void;
    retryDisabled?: boolean;
}

const STATE_LABEL: Record<DeployStepView['state'], string> = {
    upcoming: 'not started',
    active: 'in progress',
    complete: 'complete',
    failed: 'failed',
    warning: 'delayed',
};

function StepIcon({ state, index }: { state: DeployStepView['state']; index: number }) {
    const base = 'flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full border-2 text-sm font-semibold';

    switch (state) {
        case 'complete':
            return (
                <span className={`${base} border-green-600 bg-green-600 text-white`} aria-hidden="true">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                </span>
            );
        case 'failed':
            return (
                <span className={`${base} border-red-600 bg-red-600 text-white`} aria-hidden="true">
                    <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                </span>
            );
        case 'warning':
            return (
                <span className={`${base} border-yellow-500 bg-yellow-50 text-yellow-700`} aria-hidden="true">
                    !
                </span>
            );
        case 'active':
            return (
                <span className={`${base} border-blue-600 bg-white text-blue-600`} aria-hidden="true">
                    <span className="h-3 w-3 animate-pulse rounded-full bg-blue-600 motion-reduce:animate-none" />
                </span>
            );
        default:
            return (
                <span className={`${base} border-gray-300 bg-white text-gray-400`} aria-hidden="true">
                    {index + 1}
                </span>
            );
    }
}

/**
 * Real-time deployment progress: build → sign → submit → confirm → index.
 *
 * Step states come from `deriveDeploySteps` (fed by `useTokenDeploy`, whose
 * confirm step follows `useTransactionMonitor` events). A failed step shows
 * step-specific retry guidance; once a transaction hash exists it links to the
 * explorer so users can check for an in-flight transaction before retrying.
 */
export function DeploymentProgressStepper({
    steps,
    network,
    txHash,
    errorMessage,
    onRetry,
    retryDisabled = false,
}: DeploymentProgressStepperProps) {
    const failed = steps.find((s) => s.state === 'failed');
    const warning = steps.find((s) => s.state === 'warning');
    const active = steps.find((s) => s.state === 'active');
    const announcement = failed
        ? `${failed.label} step failed.`
        : warning
        ? `${warning.label} step is delayed.`
        : active
        ? `${active.label}: ${active.description}${active.detail ? `. ${active.detail}` : ''}`
        : steps.every((s) => s.state === 'complete')
        ? 'Deployment complete.'
        : '';

    return (
        <section
            className="rounded-lg border border-gray-200 bg-white p-4"
            aria-label="Deployment progress"
            data-testid="deployment-progress-stepper"
        >
            <ol className="space-y-3">
                {steps.map((step, index) => (
                    <li
                        key={step.id}
                        className="flex items-start gap-3"
                        aria-current={step.state === 'active' ? 'step' : undefined}
                        data-step={step.id}
                        data-state={step.state}
                    >
                        <StepIcon state={step.state} index={index} />
                        <div className="min-w-0 pt-1">
                            <p
                                className={`text-sm font-medium ${
                                    step.state === 'failed'
                                        ? 'text-red-700'
                                        : step.state === 'upcoming'
                                        ? 'text-gray-500'
                                        : 'text-gray-900'
                                }`}
                            >
                                {step.label}
                                <span className="sr-only"> ({STATE_LABEL[step.state]})</span>
                            </p>
                            <p className="text-xs text-gray-500">{step.description}</p>
                            {step.detail && step.state === 'active' ? (
                                <p className="mt-0.5 text-xs text-blue-700">{step.detail}</p>
                            ) : null}
                        </div>
                    </li>
                ))}
            </ol>

            <p className="sr-only" role="status" aria-live="polite">
                {announcement}
            </p>

            {failed ? (
                <StepFailure
                    step={failed.id}
                    label={failed.label}
                    errorMessage={errorMessage}
                    txHash={txHash}
                    network={network}
                    onRetry={onRetry}
                    retryDisabled={retryDisabled}
                />
            ) : null}

            {warning ? (
                <div className="mt-4 rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800" role="note">
                    {DEPLOY_STEP_RETRY_GUIDANCE[warning.id]}
                </div>
            ) : null}
        </section>
    );
}

function StepFailure({
    step,
    label,
    errorMessage,
    txHash,
    network,
    onRetry,
    retryDisabled,
}: {
    step: DeployStepId;
    label: string;
    errorMessage?: string;
    txHash?: string | null;
    network: 'testnet' | 'mainnet';
    onRetry?: () => void;
    retryDisabled: boolean;
}) {
    const mayHaveReachedNetwork = step === 'submit' || step === 'confirm';

    return (
        <div className="mt-4 rounded-md border border-red-200 bg-red-50 p-3" role="alert">
            <h3 className="text-sm font-semibold text-red-800">{label} failed</h3>
            {errorMessage ? <p className="mt-1 text-sm text-red-700">{errorMessage}</p> : null}
            <p className="mt-2 text-sm text-red-700">{DEPLOY_STEP_RETRY_GUIDANCE[step]}</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
                {onRetry ? (
                    <button
                        type="button"
                        onClick={onRetry}
                        disabled={retryDisabled}
                        className="rounded bg-red-600 px-4 py-2 text-sm text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Retry Deployment
                    </button>
                ) : null}
                {txHash && mayHaveReachedNetwork ? (
                    <a
                        href={getTxUrl(txHash, network)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-red-800 underline"
                    >
                        Check transaction in explorer
                    </a>
                ) : null}
            </div>
        </div>
    );
}
