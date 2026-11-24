# KuRuMi-Host Terminal Manager

## Overview
KuRuMi-Host is a web-based terminal manager that allows users to create and manage terminal instances. Users can login, create terminal instances, and access a full bash terminal in the browser.

## Features
- User authentication with session management
- Dashboard to manage terminal instances
- Create/Delete terminal instances
- Full terminal access via xterm.js
- GitHub integration with Personal Access Token
- Account expiry and lock system
- Instance usage tracking

## Project Structure
```
├── index.js              # Main server file (Express + Socket.io)
├── users.json            # User data storage
├── instances.json        # Instance data storage
├── public/
│   ├── login.html        # Login page
│   └── terminal.svg      # Favicon
├── views/
│   ├── dashboard.html    # Dashboard page
│   └── terminal.html     # Terminal page
└── sessions/             # Session storage
```

## Users.json Structure
```json
{
  "username": "string",
  "password": "string",
  "email": "string",
  "github_username": "string",
  "github_token": "string (Personal Access Token)",
  "repo_name": "string",
  "folder_name": "string",
  "expiry_date": "YYYY-MM-DD",
  "max_instances": 7,
  "instances_used": 0,
  "is_locked": false
}
```

## Key Features

### Account Expiry
- Each user has an `expiry_date` field
- When the date passes, the account is automatically locked
- `instances_used` is set to 0 when locked
- Server checks expiry hourly and on each login/API call

### GitHub Integration
- Uses Personal Access Token (PAT) instead of SSH keys
- Token is stored in `github_token` field
- Git credentials are configured per-user
- Supports HTTPS cloning and pushing

### Terminal Instances
- Users can create up to `max_instances` terminals
- Each instance has a unique ID and name
- Instances can be opened or deleted from the dashboard

## Routes
- `GET /` - Redirects to dashboard
- `GET /login.html` - Login page
- `GET /dashboard` - Dashboard (requires auth)
- `GET /terminal/:id` - Terminal page (requires auth)
- `POST /auth` - Login endpoint
- `GET /logout` - Logout and destroy session
- `GET /user-session` - Get current user info
- `GET /api/instances` - List user instances
- `POST /api/instances` - Create instance
- `DELETE /api/instances/:id` - Delete instance

## Recent Changes (Dec 5, 2025)
- Updated UI to match design screenshots
- Changed branding from HomoHost to NixHost
- Added orange gradient login page with terminal icon
- Created dark-themed dashboard with instance management
- Added user and date icons in dashboard header
- Updated users.json structure with new fields
- Implemented account expiry and lock system
- Changed from SSH keys to GitHub Personal Access Token
- Fixed terminal input/output issues
- Added periodic expiry check (hourly)
- Added theme toggle button (sun/moon) with animation for light/dark mode
- Added white theme with CSS variables for all colors
- Replaced browser confirm() with styled delete confirmation modal (orange cancel button)
- Removed confirm dialog from terminal stop button (now stops directly)
- Fixed terminal footer to properly display instance name and creation date
- Removed folder_name field from users.json
- Theme toggle button moved above logout, now smaller (32px) with smooth animation
- Instance cards now show uppercase names with orange terminal icons
- Delete modal shows "Instance Removed" text with slide-up animation
- Terminal footer displays [InstanceName] HH:MM DD-Mon-YY in green (live clock)
- Auto-clone GitHub repository on terminal start if repo_name configured

## Development
The server runs on port 5000. Use `node index.js` to start.

## Dependencies
- express
- express-session
- session-file-store
- socket.io
- node-pty
