-- Rolls back 0072: 3D jobs in flight lose their owner record and can no longer be polled.
DROP INDEX IF EXISTS buzzy_model3d_jobs_user;
DROP TABLE IF EXISTS buzzy_model3d_jobs;
