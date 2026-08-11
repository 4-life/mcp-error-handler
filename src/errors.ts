/** Marks a pipeline step that needs a real external integration (AI provider, Jira, GitHub, Slack) wired in before it can run. */
export class NotImplementedError extends Error {
  constructor(step: string, detail: string) {
    super(`${step} is not implemented yet: ${detail}`);
    this.name = "NotImplementedError";
  }
}
