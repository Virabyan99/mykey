-- Run 3.8: the provisioner supervises the job queue. Hand-written.
--
-- Its worker runs with pg-boss's supervisor (it expires the job of a killed
-- worker so the queue hands it out again), and pg-boss's failure path moves a
-- job between partitions. Seen in Run 3.8: with Run 3.1's rights a failing
-- job stayed `active` for ever (permission denied on job_common, version,
-- queue, job_dependency). The rights below are what the worker and the
-- supervisor were seen to use, nothing more: queue statistics stay off
-- (persistQueueStats), so the supervisor creates no partition, and the
-- provisioner still cannot create or remove a queue. The API keeps its rights.
GRANT INSERT ON jobs.job, jobs.job_common TO provisioner_runtime;--> statement-breakpoint
GRANT UPDATE ON jobs.version, jobs.queue, jobs.bam TO provisioner_runtime;--> statement-breakpoint
GRANT SELECT ON jobs.bam, jobs.job_dependency, jobs.warning TO provisioner_runtime;--> statement-breakpoint
GRANT DELETE ON jobs.job_dependency TO provisioner_runtime;--> statement-breakpoint
GRANT INSERT, DELETE ON jobs.warning TO provisioner_runtime;--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON jobs.instance TO provisioner_runtime;
