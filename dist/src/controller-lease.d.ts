export declare function controllerLeasePath(stateDir: string): string;
/** Excludes concurrent run/tick processes before either can perform an external effect. */
export declare function acquireControllerLease(stateDir: string): {
    stop(): void;
};
