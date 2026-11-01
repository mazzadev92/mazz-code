import sqlite3
import os
import time
from datetime import datetime, timezone, timedelta

DB_PATH = r"d:\Mazz Code\mazz_control\mazz_sessions.db"

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_uuid TEXT UNIQUE NOT NULL,
                model_name TEXT NOT NULL,
                target_type TEXT NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL,
                last_heartbeat REAL NOT NULL,
                duration_minutes REAL DEFAULT 0,
                idle_timeout_minutes INTEGER DEFAULT 30,
                status TEXT NOT NULL,
                endpoint_url TEXT,
                api_key TEXT,
                tokens_count INTEGER DEFAULT 0
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS quota_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp REAL NOT NULL,
                session_uuid TEXT,
                hours_billed REAL,
                action TEXT
            )
        """)
        conn.commit()

def get_current_kaggle_week_window():
    """Kaggle remet son quota a zero chaque samedi a 00:00 UTC."""
    now = datetime.now(timezone.utc)
    # 0 = Monday, ..., 5 = Saturday, 6 = Sunday
    days_since_saturday = (now.weekday() - 5) % 7
    saturday_start = (now - timedelta(days=days_since_saturday)).replace(
        hour=0, minute=0, second=0, microsecond=0
    )
    saturday_ts = saturday_start.timestamp()
    next_saturday_ts = (saturday_start + timedelta(days=7)).timestamp()
    return saturday_ts, next_saturday_ts

def get_quota_status():
    init_db()
    week_start, week_end = get_current_kaggle_week_window()
    
    with get_db() as conn:
        # Sum duration of Kaggle GPU sessions completed this week
        rows = conn.execute("""
            SELECT duration_minutes, status, start_time, end_time, last_heartbeat
            FROM sessions
            WHERE target_type = 'kaggle_t4' AND start_time >= ?
        """, (week_start,)).fetchall()
        
        total_minutes = 0.0
        active_session = None
        
        for r in rows:
            if r["status"] == "running":
                # Calculate running duration up to now
                curr_dur = (time.time() - r["start_time"]) / 60.0
                total_minutes += curr_dur
                active_session = dict(r)
            else:
                total_minutes += (r["duration_minutes"] or 0.0)
                
    used_hours = round(total_minutes / 60.0, 2)
    max_hours = 30.0
    remaining_hours = max(0.0, round(max_hours - used_hours, 2))
    percent = min(100.0, round((used_hours / max_hours) * 100, 1))
    
    alert = "normal"
    if used_hours >= 29.0:
        alert = "blocked"
    elif used_hours >= 27.0:
        alert = "critical"
    elif used_hours >= 20.0:
        alert = "warning"
        
    return {
        "used_hours": used_hours,
        "remaining_hours": remaining_hours,
        "max_hours": max_hours,
        "percentage": percent,
        "alert_level": alert,
        "week_reset_utc": datetime.fromtimestamp(week_end, timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC"),
        "has_active_session": active_session is not None
    }

def register_session_start(session_uuid, model_name, target_type, idle_timeout_minutes=30, endpoint_url=None, api_key=None):
    init_db()
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            INSERT INTO sessions (
                session_uuid, model_name, target_type, start_time, last_heartbeat,
                idle_timeout_minutes, status, endpoint_url, api_key
            ) VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?)
        """, (session_uuid, model_name, target_type, now, now, idle_timeout_minutes, endpoint_url, api_key))
        conn.commit()

def update_session_activity(session_uuid, tokens_added=0):
    now = time.time()
    with get_db() as conn:
        conn.execute("""
            UPDATE sessions 
            SET last_heartbeat = ?, tokens_count = tokens_count + ?
            WHERE session_uuid = ? AND status = 'running'
        """, (now, tokens_added, session_uuid))
        conn.commit()

def register_session_stop(session_uuid, status="completed"):
    now = time.time()
    with get_db() as conn:
        row = conn.execute("SELECT start_time FROM sessions WHERE session_uuid = ?", (session_uuid,)).fetchone()
        if row:
            start_time = row["start_time"]
            duration_minutes = round((now - start_time) / 60.0, 2)
            conn.execute("""
                UPDATE sessions 
                SET end_time = ?, duration_minutes = ?, status = ?
                WHERE session_uuid = ?
            """, (now, duration_minutes, status, session_uuid))
            conn.commit()
            return duration_minutes
    return 0.0

def get_active_session():
    init_db()
    with get_db() as conn:
        row = conn.execute("""
            SELECT * FROM sessions 
            WHERE status = 'running' 
            ORDER BY start_time DESC LIMIT 1
        """).fetchone()
        if row:
            return dict(row)
    return None

def check_inactivity_timeouts():
    """Verifie si la session active a depasse son timeout d'inactivite."""
    sess = get_active_session()
    if not sess:
        return None
    
    timeout_sec = sess["idle_timeout_minutes"] * 60
    idle_time = time.time() - sess["last_heartbeat"]
    
    if idle_time > timeout_sec:
        register_session_stop(sess["session_uuid"], status="timed_out")
        return {
            "session_uuid": sess["session_uuid"],
            "timed_out": True,
            "idle_minutes": round(idle_time / 60.0, 1),
            "max_timeout_minutes": sess["idle_timeout_minutes"]
        }
    return None
