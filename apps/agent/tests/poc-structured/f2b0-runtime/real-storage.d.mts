export function createExclusiveRunLock(file: string, metadata: Record<string, unknown>): Promise<{ file: string; release(): Promise<void> }>;
export function createCaseReservation(directory: string, caseID: string, metadata: Record<string, unknown>): Promise<string>;
export function authorizedRetryFileName(directory: string, caseID: string, newRunID: string): string;
export function listAuthorizedRetryReservations(directory: string, caseID: string): Promise<string[]>;
export function createAuthorizedRetryReservation(directory: string, caseID: string, newRunID: string, metadata: Record<string, unknown>): Promise<string>;
export function listReservationIDs(directory: string): Promise<string[]>;
export function finalizeStoppedRun(runDir: string, runID: string, caseIDs: string[], caseResults: Array<Record<string, any>>, stop: Record<string, unknown>): Promise<Record<string, any>>;
