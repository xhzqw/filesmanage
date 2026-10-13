-- One private notification per recipient and trash operation, without names.
CREATE TABLE favorite_notifications (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 recipient_id text NOT NULL REFERENCES users(id),
 trash_id text NOT NULL REFERENCES trash_entries(id),
 event_kind text NOT NULL CHECK (event_kind IN ('trashed','restored','purged')),
 affected_count integer NOT NULL CHECK (affected_count>0),
 created_at timestamptz NOT NULL DEFAULT now(),
 read_at timestamptz,
 UNIQUE(recipient_id,trash_id,event_kind)
);
CREATE INDEX ix_favorite_notifications_user ON favorite_notifications(recipient_id,id DESC);

-- The folder subtree is resolved once per trash operation. This trigger runs
-- after files are soft-deleted but before the favorites are purged, inside
-- the same business transaction. One row is created per affected recipient.
CREATE FUNCTION favorite_trash_notify() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE kind text;
BEGIN
 IF TG_OP='INSERT' THEN
  kind := 'trashed';
 ELSIF NEW.restored_at IS NOT NULL AND OLD.restored_at IS NULL THEN
  kind := 'restored';
 ELSIF NEW.purged_at IS NOT NULL AND OLD.purged_at IS NULL THEN
  kind := 'purged';
 ELSE
  RETURN NEW;
 END IF;
 IF NEW.file_id IS NOT NULL THEN
  INSERT INTO favorite_notifications(recipient_id,trash_id,event_kind,affected_count)
  SELECT fa.user_id,NEW.id,kind,count(*)::integer FROM favorites fa
  WHERE fa.file_id=NEW.file_id AND fa.user_id<>NEW.deleted_by
  GROUP BY fa.user_id
  ON CONFLICT(recipient_id,trash_id,event_kind) DO NOTHING;
 ELSE
  WITH RECURSIVE descendants(id) AS (
   SELECT NEW.folder_id
   UNION ALL SELECT f.id FROM folders f JOIN descendants d ON f.parent_id=d.id
  ), affected AS (
   SELECT fa.user_id FROM favorites fa JOIN descendants d ON fa.folder_id=d.id
   UNION ALL
   SELECT fa.user_id FROM favorites fa
   JOIN files f ON f.id=fa.file_id JOIN descendants d ON f.folder_id=d.id
  )
  INSERT INTO favorite_notifications(recipient_id,trash_id,event_kind,affected_count)
  SELECT a.user_id,NEW.id,kind,count(*)::integer FROM affected a
  WHERE a.user_id<>NEW.deleted_by GROUP BY a.user_id
  ON CONFLICT(recipient_id,trash_id,event_kind) DO NOTHING;
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER favorite_trash_notification_changed
 AFTER INSERT OR UPDATE OF restored_at,purged_at ON trash_entries
 FOR EACH ROW EXECUTE FUNCTION favorite_trash_notify();

-- Recipient-specific durable WebSocket hint; no broadcast of resource data.
CREATE TRIGGER realtime_favorite_notifications
 AFTER INSERT OR UPDATE OR DELETE ON favorite_notifications
 FOR EACH ROW EXECUTE FUNCTION realtime_private_changed('recipient_id','workspace.changed','collaboration');
