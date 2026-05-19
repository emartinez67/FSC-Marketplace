-- Profiles -------------------------------------------------------------------------------------------------------
CREATE TABLE profiles (
  id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     TEXT        NOT NULL DEFAULT '',
  phone         TEXT,
  bio           TEXT        DEFAULT '',
  major         TEXT        DEFAULT '',
  graduation_year INT,
  avatar_url    TEXT,
  notify_messages   BOOLEAN NOT NULL DEFAULT TRUE,
  notify_listings   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public profiles are viewable by everyone"
ON profiles FOR SELECT
USING (true);

CREATE POLICY "Users can insert own profile"
ON profiles FOR INSERT
WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile"
ON profiles FOR UPDATE
USING (auth.uid() = id);

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER profiles_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, phone)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
    NEW.raw_user_meta_data ->> 'phone'
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION handle_new_user();

INSERT INTO profiles (id, full_name, phone)
SELECT
  id,
  COALESCE(raw_user_meta_data ->> 'full_name', ''),
  raw_user_meta_data ->> 'phone'
FROM auth.users
WHERE id NOT IN (SELECT id FROM profiles)
ON CONFLICT (id) DO NOTHING;

-- Avatars -------------------------------------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public)
VALUES ('avatars', 'avatars', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Avatar images are publicly accessible"
ON storage.objects FOR SELECT
USING (bucket_id = 'avatars');

CREATE POLICY "Users can upload own avatar"
ON storage.objects FOR INSERT
WITH CHECK (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can update own avatar"
ON storage.objects FOR UPDATE
USING (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

CREATE POLICY "Users can delete own avatar"
ON storage.objects FOR DELETE
USING (
  bucket_id = 'avatars'
  AND auth.uid()::text = (storage.foldername(name))[1]
);

-- Trigger function for when a user updates their full_name in profiles, updates all listings/reviews -------------------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_user_name_changes()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.full_name IS DISTINCT FROM NEW.full_name THEN
    UPDATE listings
    SET seller_name = NEW.full_name
    WHERE user_id = NEW.id;

    UPDATE reviews
    SET reviewer_name = NEW.full_name
    WHERE reviewer_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_profile_name_change ON profiles;
CREATE TRIGGER on_profile_name_change
  AFTER UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION sync_user_name_changes();

UPDATE listings l
SET seller_name = p.full_name
FROM profiles p
WHERE l.user_id = p.id
  AND l.seller_name IS DISTINCT FROM p.full_name;

UPDATE reviews r
SET reviewer_name = p.full_name
FROM profiles p
WHERE r.reviewer_id = p.id
  AND r.reviewer_name IS DISTINCT FROM p.full_name;

-- Saved listings -------------------------------------------------------------------------------------------------------
CREATE TABLE saved_listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(user_id, listing_id)
);

ALTER TABLE saved_listings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own saves"
ON saved_listings FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "Users can save listings"
ON saved_listings FOR INSERT
WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can unsave listings"
ON saved_listings FOR DELETE
USING (auth.uid() = user_id);

-- Updated bidirectional reviews -------------------------------------------------------------------------------------------------------
ALTER TABLE reviews
  ADD COLUMN IF NOT EXISTS review_type text NOT NULL DEFAULT 'buyer_to_seller',
  ADD COLUMN IF NOT EXISTS reviewer_name text NOT NULL DEFAULT 'Anonymous',
  ADD COLUMN IF NOT EXISTS reviewed_user_id uuid;

UPDATE reviews SET reviewed_user_id = seller_id WHERE reviewed_user_id IS NULL;

ALTER TABLE reviews ALTER COLUMN reviewed_user_id SET NOT NULL;

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_listing_id_reviewer_id_key;
ALTER TABLE reviews ADD CONSTRAINT reviews_listing_id_reviewer_id_key UNIQUE (listing_id, reviewer_id);

CREATE INDEX IF NOT EXISTS idx_reviews_reviewed_user_id ON reviews (reviewed_user_id);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewer_id ON reviews (reviewer_id);

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_review_type_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_review_type_check
  CHECK (review_type IN ('buyer_to_seller', 'seller_to_buyer'));

-- Profile lookup -------------------------------------------------------------------------------------------------------
CREATE POLICY "Anyone can view profiles"
ON profiles FOR SELECT
USING (true);

-- Transaction history -------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id  UUID NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  seller_id   UUID NOT NULL,
  buyer_id    UUID,                          
  price       NUMERIC(10,2) NOT NULL,
  title       TEXT NOT NULL,                 
  category    TEXT NOT NULL DEFAULT '',   
  images      JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'completed', 
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_seller ON transactions(seller_id);
CREATE INDEX IF NOT EXISTS idx_transactions_buyer  ON transactions(buyer_id);
CREATE INDEX IF NOT EXISTS idx_transactions_listing ON transactions(listing_id);

ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own transactions"
ON transactions FOR SELECT
USING (auth.uid() = seller_id OR auth.uid() = buyer_id);

CREATE POLICY "Sellers can create transactions"
ON transactions FOR INSERT
WITH CHECK (auth.uid() = seller_id);

CREATE POLICY "Sellers can update own transactions"
ON transactions FOR UPDATE
USING (auth.uid() = seller_id);

CREATE POLICY "Admins view all transactions"
ON transactions FOR SELECT
USING (public.is_admin());

CREATE OR REPLACE FUNCTION create_transaction_on_sold()
RETURNS TRIGGER AS $$
DECLARE
  v_buyer_id UUID;
BEGIN
  IF NEW.status = 'sold' AND (OLD.status IS DISTINCT FROM 'sold') THEN
    SELECT buyer_id INTO v_buyer_id
    FROM conversations
    WHERE listing_id = NEW.id
    ORDER BY updated_at DESC
    LIMIT 1;

    INSERT INTO transactions (listing_id, seller_id, buyer_id, price, title, category, images)
    VALUES (
      NEW.id,
      NEW.user_id,
      v_buyer_id,
      NEW.price,
      NEW.title,
      NEW.category,
      COALESCE(NEW.images, '[]'::jsonb)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_listing_sold ON listings;

CREATE TRIGGER on_listing_sold
AFTER UPDATE ON listings
FOR EACH ROW
EXECUTE FUNCTION create_transaction_on_sold();

-- Notifications -------------------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT,
  read        BOOLEAN NOT NULL DEFAULT false,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user      ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_notifications_created   ON notifications(created_at DESC);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users view own notifications"
ON notifications FOR SELECT
USING (auth.uid() = user_id);

CREATE POLICY "System or self insert notifications"
ON notifications FOR INSERT
WITH CHECK (true);

CREATE POLICY "Users update own notifications"
ON notifications FOR UPDATE
USING (auth.uid() = user_id);

CREATE POLICY "Users delete own notifications"
ON notifications FOR DELETE
USING (auth.uid() = user_id);

CREATE POLICY "Admins view all notifications"
ON notifications FOR SELECT
USING (public.is_admin());

CREATE OR REPLACE FUNCTION notify_on_new_message()
RETURNS TRIGGER AS $$
DECLARE
  v_other_id     UUID;
  v_sender_name  TEXT;
  v_listing_title TEXT;
  v_conv         RECORD;
BEGIN
  SELECT * INTO v_conv FROM conversations WHERE id = NEW.conversation_id;
  IF NOT FOUND THEN RETURN NEW; END IF;

  IF v_conv.buyer_id = NEW.sender_id THEN
    v_other_id := v_conv.seller_id;
  ELSE
    v_other_id := v_conv.buyer_id;
  END IF;

  SELECT full_name INTO v_sender_name
  FROM profiles WHERE id = NEW.sender_id;
  v_sender_name := COALESCE(v_sender_name, 'Someone');

  IF v_conv.listing_id IS NOT NULL THEN
    SELECT title INTO v_listing_title
    FROM listings WHERE id = v_conv.listing_id;
  END IF;

  INSERT INTO notifications (user_id, type, title, body, link, data)
  VALUES (
    v_other_id,
    'message',
    v_sender_name || ' sent you a message',
    LEFT(NEW.content, 120),
    '/messages',
    jsonb_build_object(
      'conversation_id', NEW.conversation_id,
      'sender_id', NEW.sender_id,
      'sender_name', v_sender_name,
      'listing_title', COALESCE(v_listing_title, '')
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_new_message_notify ON messages;
CREATE TRIGGER on_new_message_notify
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION notify_on_new_message();

CREATE OR REPLACE FUNCTION notify_on_listing_status_change()
RETURNS TRIGGER AS $$
DECLARE
  v_buyer_id UUID;
BEGIN
  IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
    RETURN NEW;
  END IF;

  IF NEW.status = 'sold' THEN
    INSERT INTO notifications (user_id, type, title, body, link, data)
    VALUES (
      NEW.user_id,
      'listing_sold',
      'Your listing has been marked as sold',
      '"' || LEFT(NEW.title, 80) || '" is now marked as sold.',
      '/item?id=' || NEW.id,
      jsonb_build_object('listing_id', NEW.id, 'listing_title', NEW.title, 'price', NEW.price)
    );

    SELECT buyer_id INTO v_buyer_id
    FROM conversations
    WHERE listing_id = NEW.id
    ORDER BY updated_at DESC
    LIMIT 1;

    IF v_buyer_id IS NOT NULL THEN
      INSERT INTO notifications (user_id, type, title, body, link, data)
      VALUES (
        v_buyer_id,
        'listing_sold',
        'A listing you inquired about was sold',
        '"' || LEFT(NEW.title, 80) || '" has been marked as sold.',
        '/item?id=' || NEW.id,
        jsonb_build_object('listing_id', NEW.id, 'listing_title', NEW.title, 'price', NEW.price)
      );
    END IF;

  ELSIF NEW.status = 'pending' THEN
    INSERT INTO notifications (user_id, type, title, body, link, data)
    VALUES (
      NEW.user_id,
      'listing_pending',
      'Your listing is now pending',
      '"' || LEFT(NEW.title, 80) || '" has been marked as pending.',
      '/item?id=' || NEW.id,
      jsonb_build_object('listing_id', NEW.id, 'listing_title', NEW.title)
    );
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_listing_status_notify ON listings;
CREATE TRIGGER on_listing_status_notify
AFTER UPDATE ON listings
FOR EACH ROW
EXECUTE FUNCTION notify_on_listing_status_change();

CREATE OR REPLACE FUNCTION notify_on_new_review()
RETURNS TRIGGER AS $$
DECLARE
  v_listing_title TEXT;
BEGIN
  SELECT title INTO v_listing_title
  FROM listings WHERE id = NEW.listing_id;

  INSERT INTO notifications (user_id, type, title, body, link, data)
  VALUES (
    NEW.reviewed_user_id,
    'review',
    NEW.reviewer_name || ' left you a ' || NEW.rating || '-star review',
    COALESCE(LEFT(NEW.comment, 120), 'No comment'),
    '/reviews?id=' || NEW.reviewed_user_id,
    jsonb_build_object(
      'listing_id', NEW.listing_id,
      'listing_title', COALESCE(v_listing_title, ''),
      'reviewer_name', NEW.reviewer_name,
      'rating', NEW.rating,
      'review_type', NEW.review_type
    )
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_new_review_notify ON reviews;
CREATE TRIGGER on_new_review_notify
AFTER INSERT ON reviews
FOR EACH ROW
EXECUTE FUNCTION notify_on_new_review();

CREATE OR REPLACE FUNCTION notify_on_report_resolved()
RETURNS TRIGGER AS $$
DECLARE
  v_listing_title TEXT;
BEGIN
  IF OLD.status = NEW.status THEN RETURN NEW; END IF;
  IF NEW.status NOT IN ('resolved', 'dismissed') THEN RETURN NEW; END IF;

  SELECT title INTO v_listing_title
  FROM listings WHERE id = NEW.listing_id;

  INSERT INTO notifications (user_id, type, title, body, link, data)
  VALUES (
    NEW.reporter_id,
    'report_resolved',
    'Your report has been ' || NEW.status,
    'Your report on "' || COALESCE(LEFT(v_listing_title, 80), 'a listing') || '" has been reviewed.',
    '/marketplace',
    jsonb_build_object('listing_id', NEW.listing_id, 'report_status', NEW.status)
  );

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_report_resolved_notify ON reports;
CREATE TRIGGER on_report_resolved_notify
AFTER UPDATE ON reports
FOR EACH ROW
EXECUTE FUNCTION notify_on_report_resolved();

ALTER PUBLICATION supabase_realtime ADD TABLE notifications;

-- Open to offers -------------------------------------------------------------------------------------------------------
ALTER TABLE listings
ADD COLUMN IF NOT EXISTS open_to_offers BOOLEAN NOT NULL DEFAULT false;