export declare function controllerHeartbeatPath(stateDir: string): string;
export declare function startControllerHeartbeat(stateDir: string, intervalMs?: number): {
    stop(): void;
};
