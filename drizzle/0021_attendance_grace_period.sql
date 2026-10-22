-- Normalize both legacy and current attendance snapshots with a 15-minute
-- inclusive on-time window. Convert the timestamp difference to whole
-- milliseconds first so +15:00.000 and +15:00.001 remain distinct.
UPDATE shift_sessions
SET attendance_delta_minutes = CASE
      WHEN CAST(ROUND((julianday(started_at) - julianday(scheduled_start_at)) * 86400000) AS INTEGER) < 0
        THEN -CAST((
          ABS(CAST(ROUND((julianday(started_at) - julianday(scheduled_start_at)) * 86400000) AS INTEGER))
          + 59999
        ) / 60000 AS INTEGER)
      ELSE CAST((
        CAST(ROUND((julianday(started_at) - julianday(scheduled_start_at)) * 86400000) AS INTEGER)
        + 59999
      ) / 60000 AS INTEGER)
    END,
    attendance_status = CASE
      WHEN CAST(ROUND((julianday(started_at) - julianday(scheduled_start_at)) * 86400000) AS INTEGER) < 0
        THEN 'EARLY'
      WHEN CAST(ROUND((julianday(started_at) - julianday(scheduled_start_at)) * 86400000) AS INTEGER) <= 900000
        THEN 'ON_TIME'
      ELSE 'LATE'
    END
WHERE scheduled_start_at IS NOT NULL
  AND julianday(started_at) IS NOT NULL
  AND julianday(scheduled_start_at) IS NOT NULL;
