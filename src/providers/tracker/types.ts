import type { AppConfig, ErrorReport, Ticket } from "../../types.js";

/** A work tracker: Jira today, GitHub Issues/Redmine implement the same shape later. */
export interface TrackerProvider {
  createTicket(config: AppConfig, report: ErrorReport, analysis: string, assigneeEmail?: string): Promise<Ticket>;
}
