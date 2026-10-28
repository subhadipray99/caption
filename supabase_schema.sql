-- Caption Studio Database Schema
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/jsrxiehmnqatqoyqopun/sql

-- 1. Create projects table
CREATE TABLE IF NOT EXISTS public.projects (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    video_url TEXT,
    video_storage_path TEXT,
    status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded', 'extracting', 'transcribing', 'converting_hinglish', 'ready', 'exporting', 'error')),
    progress INTEGER NOT NULL DEFAULT 0,
    language TEXT,
    target_lang TEXT DEFAULT 'auto',
    error TEXT,
    captions JSONB NOT NULL DEFAULT '[]'::jsonb,
    style JSONB,
    export_file_url TEXT,
    exported_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- 2. Index for faster query sorting
CREATE INDEX IF NOT EXISTS idx_projects_created_at ON public.projects(created_at DESC);

-- 3. Enable Row Level Security (RLS)
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

-- 4. Development / Anonymous access policy (can be scoped to auth.uid() once user login is added)
CREATE POLICY "Allow public read on projects" ON public.projects
    FOR SELECT USING (true);

CREATE POLICY "Allow public insert on projects" ON public.projects
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on projects" ON public.projects
    FOR UPDATE USING (true);

CREATE POLICY "Allow public delete on projects" ON public.projects
    FOR DELETE USING (true);


-- 5. User Credits Table (Video Minutes Balance)
CREATE TABLE IF NOT EXISTS public.user_credits (
    user_id UUID PRIMARY KEY,
    balance_seconds NUMERIC NOT NULL DEFAULT 60, -- 1 min (60s) free starter credits for first-time registered users
    total_purchased_seconds NUMERIC NOT NULL DEFAULT 0,
    total_used_seconds NUMERIC NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on user_credits" ON public.user_credits
    FOR SELECT USING (true);

CREATE POLICY "Allow public insert on user_credits" ON public.user_credits
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on user_credits" ON public.user_credits
    FOR UPDATE USING (true);

-- 6. Razorpay Payments Ledger Table
CREATE TABLE IF NOT EXISTS public.payments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    razorpay_order_id TEXT NOT NULL UNIQUE,
    razorpay_payment_id TEXT,
    razorpay_signature TEXT,
    amount NUMERIC NOT NULL,
    currency TEXT NOT NULL DEFAULT 'INR',
    minutes_credited NUMERIC NOT NULL,
    status TEXT NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'captured', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read on payments" ON public.payments
    FOR SELECT USING (true);

CREATE POLICY "Allow public insert on payments" ON public.payments
    FOR INSERT WITH CHECK (true);

CREATE POLICY "Allow public update on payments" ON public.payments
    FOR UPDATE USING (true);
