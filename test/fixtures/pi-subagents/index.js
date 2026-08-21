export default function fixture(pi) {
  pi.registerTool({
    name: "subagent",
    async execute(_id, input) {
      if (input.tasks !== undefined) {
        return {
          content: [{ type: "text", text: "Legacy top-level chain and parallel inputs were removed; use workflowScript." }],
          isError: true,
          details: { mode: "management", results: [] },
        };
      }
      const prefix = "return await runs.all(";
      const suffix = ");";
      if (typeof input.workflowScript !== "string" || !input.workflowScript.startsWith(prefix) || !input.workflowScript.endsWith(suffix)) {
        return { content: [{ type: "text", text: "workflowScript required" }], isError: true, details: { mode: "workflow", results: [] } };
      }
      const entries = JSON.parse(input.workflowScript.slice(prefix.length, -suffix.length));
      return {
        content: [{ type: "text", text: "Workflow completed." }],
        isError: false,
        details: {
          mode: "workflow",
          results: entries.map((entry, index) => ({
            index,
            agent: entry.agent,
            task: entry.task,
            exitCode: 0,
            finalOutput: process.env.FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES
              ? `${entry.key}: ${"x".repeat(Number(process.env.FAKE_PI_REVIEW_AXIS_OUTPUT_BYTES))}`
              : `${entry.key}: no findings`,
          })),
        },
      };
    },
  });
}
