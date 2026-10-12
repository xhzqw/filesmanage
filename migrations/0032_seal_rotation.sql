-- Recorded angle is immutable evidence, not a live mutable PDF overlay.
-- Existing signed files retain exactly their original zero-degree orientation.
ALTER TABLE file_seal_marks ADD COLUMN angle_degrees numeric(6,2) NOT NULL DEFAULT 0
 CHECK (angle_degrees BETWEEN -180 AND 180);
