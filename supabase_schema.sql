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
