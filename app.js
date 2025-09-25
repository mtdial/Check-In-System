const DATA_KEY = 'uofsc_checkin_data_v1';
const BASE_COLLEGES = [
  'College of Arts & Sciences',
  'Darla Moore School of Business',
  'College of Engineering & Computing',
  'College of Hospitality, Retail and Sport Management',
  'College of Information & Communications',
  'Arnold School of Public Health',
  'College of Nursing',
  'College of Education',
  'College of Pharmacy',
  'Honors College'
];

const SOUND_NAMES = {
  ding: 'Bright ding',
  doorbell: 'Doorbell chime',
  'door-open': 'Door opening sweep'
};

const state = {
  data: null,
  currentAdvisor: null,
  currentAdmin: null,
  advisorQueueIds: new Set(),
  advisorInitialized: false
};

const studentElements = {};
const advisorElements = {};
const adminElements = {};

// Utility helpers --------------------------------------------------------

const id = (selector) => document.getElementById(selector);

function createId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function hashPassword(password) {
  if (window.crypto?.subtle && window.TextEncoder) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return btoa(password);
}

async function passwordsMatch(storedHash, password) {
  const comparisonHash = await hashPassword(password);
  return storedHash === comparisonHash;
}

function loadData() {
  const raw = localStorage.getItem(DATA_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('Unable to parse saved data. Resetting.', err);
    return null;
  }
}

async function createDefaultData() {
  const ownerAccount = {
    id: createId('admin'),
    username: 'MTDIAL',
    email: 'mtdial@email.sc.edu',
    passwordHash: await hashPassword('NELSON11!'),
    role: 'owner'
  };

  return {
    admins: [ownerAccount],
    advisors: [],
    reasons: [
      { id: createId('reason'), label: 'Academic advising follow-up' },
      { id: createId('reason'), label: 'Course registration support' },
      { id: createId('reason'), label: 'Change of major exploration' },
      { id: createId('reason'), label: 'Scholarship or financial aid question' }
    ],
    queue: [],
    colleges: []
  };
}

function saveData() {
  localStorage.setItem(DATA_KEY, JSON.stringify(state.data));
  window.dispatchEvent(new Event('checkin-data-updated'));
}

function showMessage(element, message, type = 'notice') {
  if (!element) return;
  element.textContent = '';
  element.classList.remove('success', 'error');
  if (type === 'success') {
    element.classList.add('success');
  } else if (type === 'error') {
    element.classList.add('error');
  }
  element.textContent = message;
  element.hidden = false;
}

function clearMessage(element) {
  if (!element) return;
  element.hidden = true;
  element.textContent = '';
  element.classList.remove('success', 'error');
}

function getAllColleges() {
  const colleges = new Set(BASE_COLLEGES);
  state.data.colleges.forEach((c) => colleges.add(c));
  state.data.advisors.forEach((advisor) => {
    if (advisor.college) colleges.add(advisor.college);
  });
  return Array.from(colleges).sort((a, b) => a.localeCompare(b));
}

function getAdvisorsByCollege(college) {
  return state.data.advisors.filter((advisor) => advisor.college === college);
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatRelativeTime(timestamp) {
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const diffMinutes = Math.max(1, Math.round(diffMs / 60000));
  if (diffMinutes < 60) {
    return `${diffMinutes} min ago`;
  }
  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  if (hours === 1) {
    return minutes ? `1 hr ${minutes} min ago` : '1 hr ago';
  }
  return minutes ? `${hours} hrs ${minutes} min ago` : `${hours} hrs ago`;
}

function advisorDisplayName(advisor) {
  return `${advisor.firstName} ${advisor.lastName}`.trim();
}

function queueDisplayName(entry) {
  if (!entry.advisorUsername || entry.advisorUsername === 'ANY') {
    return 'Any available advisor';
  }
  const advisor = state.data.advisors.find((a) => a.username === entry.advisorUsername);
  return advisor ? advisorDisplayName(advisor) : entry.advisorName || 'Advisor';
}

function ensureCollege(value) {
  if (!value) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  if (!state.data.colleges.includes(trimmed) && !BASE_COLLEGES.includes(trimmed)) {
    state.data.colleges.push(trimmed);
  }
}

// Tab navigation --------------------------------------------------------

function setupTabs() {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.target;
      document.querySelectorAll('.tab-button').forEach((btn) => btn.classList.remove('active'));
      document.querySelectorAll('.view').forEach((view) => view.classList.remove('active'));
      button.classList.add('active');
      id(target)?.classList.add('active');
    });
  });
}

// Student view ----------------------------------------------------------

function setupStudentView() {
  studentElements.form = id('student-form');
  studentElements.college = id('student-college');
  studentElements.advisor = id('student-advisor');
  studentElements.reason = id('student-reason');
  studentElements.message = id('student-message');
  studentElements.success = id('student-success');

  populateCollegeOptions();
  populateReasonOptions();
  populateAdvisorOptions('');

  studentElements.college.addEventListener('change', () => {
    populateAdvisorOptions(studentElements.college.value);
  });

  studentElements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage(studentElements.message);
    studentElements.success.hidden = true;

    const name = id('student-name').value.trim();
    const email = id('student-email').value.trim();
    const college = studentElements.college.value;
    const advisorUsername = studentElements.advisor.value;
    const reasonId = studentElements.reason.value;
    const notes = id('student-notes').value.trim();

    if (!/@(email|mail|sc)\.sc\.edu$/i.test(email)) {
      showMessage(studentElements.message, 'Please use your USC @email.sc.edu address.', 'error');
      return;
    }

    if (!reasonId) {
      showMessage(studentElements.message, 'Please select a reason so we can route your visit.', 'error');
      return;
    }

    const selectedReason = state.data.reasons.find((reason) => reason.id === reasonId);
    if (!selectedReason) {
      showMessage(studentElements.message, 'Selected reason is no longer available. Please refresh.', 'error');
      return;
    }

    const entry = {
      id: createId('queue'),
      studentName: name,
      studentEmail: email,
      college,
      advisorUsername,
      advisorName: advisorUsername === 'ANY' ? 'Any available advisor' : undefined,
      reasonId,
      reasonLabel: selectedReason.label,
      notes,
      timestamp: new Date().toISOString()
    };

    state.data.queue.push(entry);
    saveData();
    studentElements.form.reset();
    populateAdvisorOptions('');
    showMessage(studentElements.success, 'You are checked in. We will be with you shortly!', 'success');
    studentElements.success.hidden = false;
    setTimeout(() => {
      studentElements.success.hidden = true;
    }, 6000);
  });
}

function populateCollegeOptions() {
  const colleges = getAllColleges();
  studentElements.college.innerHTML = '<option value="">Select a college…</option>' +
    colleges.map((college) => `<option value="${college}">${college}</option>`).join('');
}

function populateAdvisorOptions(college) {
  const advisors = college ? getAdvisorsByCollege(college) : [];
  const options = ["<option value=''>Select an advisor…</option>"];
  if (college && advisors.length > 0) {
    options.push("<option value='ANY'>Any available advisor</option>");
    advisors.sort((a, b) => advisorDisplayName(a).localeCompare(advisorDisplayName(b))).forEach((advisor) => {
      options.push(`<option value="${advisor.username}">${advisorDisplayName(advisor)}</option>`);
    });
  } else if (college) {
    options.push("<option value='ANY'>Any advisor in this college</option>");
  }
  studentElements.advisor.innerHTML = options.join('');
}

function populateReasonOptions() {
  const options = ["<option value=''>Select a reason…</option>"];
  state.data.reasons
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .forEach((reason) => {
      options.push(`<option value="${reason.id}">${reason.label}</option>`);
    });
  studentElements.reason.innerHTML = options.join('');
  studentElements.reason.disabled = state.data.reasons.length === 0;
  id('student-form').querySelector('button[type="submit"]').disabled = state.data.reasons.length === 0;
}

// Advisor view ----------------------------------------------------------

function setupAdvisorView() {
  advisorElements.loginCard = id('advisor-login-card');
  advisorElements.dashboard = id('advisor-dashboard');
  advisorElements.message = id('advisor-message');
  advisorElements.queueWrapper = id('advisor-queue');
  advisorElements.name = id('advisor-name');
  advisorElements.soundSelect = id('sound-preference');
  advisorElements.previewButton = id('preview-sound');
  advisorElements.logoutButton = id('advisor-logout');

  id('advisor-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage(advisorElements.message);

    const usernameInput = id('advisor-username').value.trim().toUpperCase();
    const password = id('advisor-password').value;
    const advisor = state.data.advisors.find((a) => a.username === usernameInput);

    if (!advisor) {
      showMessage(advisorElements.message, 'We couldn’t find that advisor account.', 'error');
      return;
    }

    const match = await passwordsMatch(advisor.passwordHash, password);
    if (!match) {
      showMessage(advisorElements.message, 'Incorrect password. Please try again.', 'error');
      return;
    }

    state.currentAdvisor = advisor;
    state.advisorQueueIds = new Set();
    state.advisorInitialized = false;
    advisorElements.name.textContent = advisorDisplayName(advisor);
    advisorElements.soundSelect.value = loadSoundPreference(advisor.username);
    id('advisor-login-form').reset();
    advisorElements.loginCard.hidden = true;
    advisorElements.dashboard.hidden = false;
    renderAdvisorQueue();
  });

  advisorElements.soundSelect.addEventListener('change', () => {
    if (!state.currentAdvisor) return;
    saveSoundPreference(state.currentAdvisor.username, advisorElements.soundSelect.value);
  });

  advisorElements.previewButton.addEventListener('click', () => {
    if (!state.currentAdvisor) return;
    playSound(advisorElements.soundSelect.value || 'ding');
  });

  advisorElements.logoutButton.addEventListener('click', () => {
    state.currentAdvisor = null;
    advisorElements.loginCard.hidden = false;
    advisorElements.dashboard.hidden = true;
  });
}

function renderAdvisorQueue() {
  if (!state.currentAdvisor) return;
  const advisor = state.currentAdvisor;
  const relevantEntries = state.data.queue.filter((entry) => {
    if (entry.advisorUsername === 'ANY') {
      return entry.college === advisor.college;
    }
    return entry.advisorUsername === advisor.username;
  });

  relevantEntries.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (relevantEntries.length === 0) {
    advisorElements.queueWrapper.innerHTML = '<div class="empty-state">No students are currently waiting for you.</div>';
  } else {
    const rows = relevantEntries
      .map((entry) => `
        <tr>
          <td>
            <strong>${entry.studentName}</strong><br/>
            <span class="timestamp">Checked in ${formatRelativeTime(entry.timestamp)}</span>
          </td>
          <td>${entry.studentEmail}</td>
          <td>${entry.college}</td>
          <td>${entry.reasonLabel}</td>
          <td>${entry.advisorUsername === 'ANY' ? 'Any available advisor' : 'Assigned to you'}</td>
          <td>
            <button class="small-button primary" data-action="serve" data-id="${entry.id}">Mark as served</button>
          </td>
        </tr>
      `)
      .join('');

    advisorElements.queueWrapper.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Student</th>
            <th>Email</th>
            <th>College</th>
            <th>Reason</th>
            <th>Assignment</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  const newIds = new Set(relevantEntries.map((entry) => entry.id));
  if (state.advisorInitialized) {
    const newEntries = relevantEntries.filter((entry) => !state.advisorQueueIds.has(entry.id));
    if (newEntries.length > 0) {
      playSound(advisorElements.soundSelect.value || 'ding');
    }
  } else {
    state.advisorInitialized = true;
  }
  state.advisorQueueIds = newIds;

  advisorElements.queueWrapper.querySelectorAll('[data-action="serve"]').forEach((button) => {
    button.addEventListener('click', () => {
      removeQueueEntry(button.dataset.id);
    });
  });
}

function loadSoundPreference(username) {
  return localStorage.getItem(`advisor-sound-${username}`) || 'ding';
}

function saveSoundPreference(username, value) {
  localStorage.setItem(`advisor-sound-${username}`, value);
}

function playSound(type) {
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const duration = 0.7;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.connect(context.destination);
  oscillator.connect(gain);

  const start = context.currentTime;
  let schedule;

  switch (type) {
    case 'doorbell':
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(660, start);
      gain.gain.exponentialRampToValueAtTime(0.4, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
      schedule = () => {
        const osc2 = context.createOscillator();
        const gain2 = context.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(880, start + 0.25);
        gain2.gain.setValueAtTime(0.0001, start + 0.25);
        gain2.gain.exponentialRampToValueAtTime(0.3, start + 0.27);
        gain2.gain.exponentialRampToValueAtTime(0.001, start + 0.7);
        osc2.connect(gain2);
        gain2.connect(context.destination);
        osc2.start(start + 0.25);
        osc2.stop(start + 0.9);
      };
      break;
    case 'door-open':
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(500, start);
      oscillator.frequency.exponentialRampToValueAtTime(220, start + duration);
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, start + duration);
      break;
    default:
      oscillator.type = 'triangle';
      oscillator.frequency.setValueAtTime(1046, start);
      gain.gain.exponentialRampToValueAtTime(0.3, start + 0.05);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.4);
      schedule = () => {
        const osc2 = context.createOscillator();
        const gain2 = context.createGain();
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(1568, start + 0.15);
        gain2.gain.setValueAtTime(0.0001, start + 0.15);
        gain2.gain.exponentialRampToValueAtTime(0.25, start + 0.18);
        gain2.gain.exponentialRampToValueAtTime(0.001, start + 0.5);
        osc2.connect(gain2);
        gain2.connect(context.destination);
        osc2.start(start + 0.15);
        osc2.stop(start + 0.6);
      };
  }

  oscillator.start(start);
  oscillator.stop(start + duration);
  if (schedule) schedule();
  setTimeout(() => {
    context.close();
  }, 1200);
}

// Admin view ------------------------------------------------------------

function setupAdminView() {
  adminElements.loginCard = id('admin-login-card');
  adminElements.dashboard = id('admin-dashboard');
  adminElements.message = id('admin-message');
  adminElements.queueWrapper = id('admin-queue');
  adminElements.advisorMessage = id('admin-advisor-message');
  adminElements.advisorTable = id('advisor-table');
  adminElements.adminTable = id('admin-table');
  adminElements.reasonTags = id('reason-tags');
  adminElements.collegeTags = id('college-tags');

  id('admin-login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage(adminElements.message);

    const username = id('admin-username').value.trim().toUpperCase();
    const password = id('admin-password').value;
    const admin = state.data.admins.find((a) => a.username === username);

    if (!admin) {
      showMessage(adminElements.message, 'Administrator account not found.', 'error');
      return;
    }

    const match = await passwordsMatch(admin.passwordHash, password);
    if (!match) {
      showMessage(adminElements.message, 'Incorrect password. Try again.', 'error');
      return;
    }

    state.currentAdmin = admin;
    adminElements.loginCard.hidden = true;
    adminElements.dashboard.hidden = false;
    id('admin-login-form').reset();
    renderAdminDashboard();
  });

  id('admin-logout').addEventListener('click', () => {
    state.currentAdmin = null;
    adminElements.loginCard.hidden = false;
    adminElements.dashboard.hidden = true;
  });

  id('add-advisor-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    clearMessage(adminElements.advisorMessage);

    const firstName = id('advisor-first-name').value.trim();
    const lastName = id('advisor-last-name').value.trim();
    const email = id('advisor-email').value.trim();
    const username = id('advisor-username-add').value.trim().toUpperCase();
    const college = id('advisor-college').value.trim();

    if (!firstName || !lastName || !email || !username || !college) {
      showMessage(adminElements.advisorMessage, 'All advisor fields are required.', 'error');
      return;
    }

    if (!/@(email|mail|sc)\.sc\.edu$/i.test(email)) {
      showMessage(adminElements.advisorMessage, 'Please use a valid USC email.', 'error');
      return;
    }

    if (state.data.advisors.some((advisor) => advisor.username === username)) {
      showMessage(adminElements.advisorMessage, 'That username is already in use.', 'error');
      return;
    }

    const defaultPassword = email.split('@')[0];
    const advisor = {
      id: createId('advisor'),
      username,
      email,
      firstName,
      lastName,
      college,
      passwordHash: await hashPassword(defaultPassword)
    };

    state.data.advisors.push(advisor);
    ensureCollege(college);
    saveData();
    id('add-advisor-form').reset();
    showMessage(adminElements.advisorMessage, `${advisorDisplayName(advisor)} added. Default password: ${defaultPassword}`, 'success');
    renderAdminDashboard();
  });

  id('advisor-csv').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    clearMessage(adminElements.advisorMessage);

    try {
      const text = await file.text();
      const imported = await importAdvisorsFromCsv(text);
      showMessage(adminElements.advisorMessage, `Imported ${imported} advisor${imported === 1 ? '' : 's'} from CSV.`, 'success');
      renderAdminDashboard();
    } catch (err) {
      console.error(err);
      showMessage(adminElements.advisorMessage, err.message || 'Unable to import advisors from CSV.', 'error');
    } finally {
      event.target.value = '';
    }
  });

  id('add-reason-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const label = id('reason-label').value.trim();
    if (!label) return;
    state.data.reasons.push({ id: createId('reason'), label });
    saveData();
    id('reason-label').value = '';
    populateReasonOptions();
    renderReasonTags();
  });

  id('add-college-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const label = id('college-label').value.trim();
    if (!label) return;
    if (!state.data.colleges.includes(label) && !BASE_COLLEGES.includes(label)) {
      state.data.colleges.push(label);
      saveData();
      id('college-label').value = '';
      populateCollegeOptions();
      renderCollegeTags();
      updateCollegeDatalist();
    }
  });

  id('add-admin-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = id('admin-email-add').value.trim();
    const username = id('admin-username-add').value.trim().toUpperCase();
    const password = id('admin-password-add').value;

    if (!email || !username || !password) {
      return;
    }

    if (state.data.admins.some((admin) => admin.username === username)) {
      alert('That administrator username already exists.');
      return;
    }

    const admin = {
      id: createId('admin'),
      username,
      email,
      passwordHash: await hashPassword(password),
      role: 'admin'
    };

    state.data.admins.push(admin);
    saveData();
    id('add-admin-form').reset();
    renderAdminTable();
  });
}

async function importAdvisorsFromCsv(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) throw new Error('CSV must include a header row and at least one advisor.');
  const headerLine = lines.shift();
  const headers = parseCsvLine(headerLine).map((h) => h.toLowerCase());

  const firstIndex = headers.findIndex((h) => ['fname', 'first_name', 'firstname'].includes(h));
  const lastIndex = headers.findIndex((h) => ['lname', 'last_name', 'lastname'].includes(h));
  const emailIndex = headers.indexOf('email');
  const usernameIndex = headers.indexOf('username');
  const collegeIndex = headers.indexOf('college');

  if ([firstIndex, lastIndex, emailIndex, usernameIndex, collegeIndex].some((idx) => idx === -1)) {
    throw new Error('CSV headers must include fname, lname, email, username, college.');
  }

  let added = 0;

  for (const line of lines) {
    const values = parseCsvLine(line);
    if (!values.length) continue;
    const firstName = values[firstIndex]?.trim();
    const lastName = values[lastIndex]?.trim();
    const email = values[emailIndex]?.trim();
    const username = values[usernameIndex]?.trim().toUpperCase();
    const college = values[collegeIndex]?.trim();

    if (!firstName || !lastName || !email || !username || !college) continue;
    if (!/@(email|mail|sc)\.sc\.edu$/i.test(email)) continue;
    if (state.data.advisors.some((advisor) => advisor.username === username)) continue;

    const defaultPassword = email.split('@')[0];
    const advisor = {
      id: createId('advisor'),
      username,
      email,
      firstName,
      lastName,
      college,
      passwordHash: await hashPassword(defaultPassword)
    };

    state.data.advisors.push(advisor);
    ensureCollege(college);
    added += 1;
  }

  if (added > 0) {
    saveData();
  }
  return added;
}

function parseCsvLine(line) {
  const values = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function removeQueueEntry(idValue) {
  const index = state.data.queue.findIndex((entry) => entry.id === idValue);
  if (index !== -1) {
    state.data.queue.splice(index, 1);
    saveData();
    renderAdvisorQueue();
    renderAdminQueue();
  }
}

function renderAdminDashboard() {
  renderAdminQueue();
  renderAdvisorTable();
  renderAdminTable();
  renderReasonTags();
  renderCollegeTags();
  updateCollegeDatalist();
  populateCollegeOptions();
}

function renderAdminQueue() {
  if (!adminElements.queueWrapper) return;
  if (state.data.queue.length === 0) {
    adminElements.queueWrapper.innerHTML = '<div class="empty-state">No students are currently waiting.</div>';
    return;
  }

  const rows = state.data.queue
    .slice()
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
    .map((entry) => `
      <tr>
        <td><strong>${entry.studentName}</strong><div class="timestamp">${formatTime(entry.timestamp)}</div></td>
        <td>${entry.studentEmail}</td>
        <td>${entry.college}</td>
        <td>${queueDisplayName(entry)}</td>
        <td>${entry.reasonLabel}</td>
        <td>${entry.notes ? entry.notes : ''}</td>
        <td><button class="small-button" data-action="remove" data-id="${entry.id}">Remove</button></td>
      </tr>
    `)
    .join('');

  adminElements.queueWrapper.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>College</th>
          <th>Advisor</th>
          <th>Reason</th>
          <th>Notes</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  adminElements.queueWrapper.querySelectorAll('[data-action="remove"]').forEach((button) => {
    button.addEventListener('click', () => removeQueueEntry(button.dataset.id));
  });
}

function renderAdvisorTable() {
  if (!adminElements.advisorTable) return;
  if (state.data.advisors.length === 0) {
    adminElements.advisorTable.innerHTML = '<div class="empty-state">No advisors have been added yet.</div>';
    return;
  }

  const rows = state.data.advisors
    .slice()
    .sort((a, b) => advisorDisplayName(a).localeCompare(advisorDisplayName(b)))
    .map((advisor) => `
      <tr>
        <td>${advisorDisplayName(advisor)}</td>
        <td>${advisor.email}</td>
        <td>${advisor.username}</td>
        <td>${advisor.college}</td>
        <td><button class="small-button danger" data-username="${advisor.username}">Remove</button></td>
      </tr>
    `)
    .join('');

  adminElements.advisorTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Username</th>
          <th>College</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  adminElements.advisorTable.querySelectorAll('button[data-username]').forEach((button) => {
    button.addEventListener('click', () => {
      const username = button.dataset.username;
      state.data.advisors = state.data.advisors.filter((advisor) => advisor.username !== username);
      state.data.queue = state.data.queue.filter((entry) => entry.advisorUsername !== username);
      saveData();
      renderAdminDashboard();
    });
  });
}

function renderAdminTable() {
  if (!adminElements.adminTable) return;
  if (state.data.admins.length === 0) {
    adminElements.adminTable.innerHTML = '';
    return;
  }

  const rows = state.data.admins
    .slice()
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((admin) => `
      <tr>
        <td>${admin.email}</td>
        <td>${admin.username}</td>
        <td>${admin.role === 'owner' ? '<span class="badge">Owner</span>' : ''}</td>
      </tr>
    `)
    .join('');

  adminElements.adminTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Email</th>
          <th>Username</th>
          <th>Role</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderReasonTags() {
  if (!adminElements.reasonTags) return;
  if (state.data.reasons.length === 0) {
    adminElements.reasonTags.innerHTML = '<div class="empty-state">No reasons available.</div>';
    return;
  }

  adminElements.reasonTags.innerHTML = state.data.reasons
    .slice()
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((reason) => `
      <span class="tag">${reason.label} <button data-reason="${reason.id}" aria-label="Remove ${reason.label}">×</button></span>
    `)
    .join('');

  adminElements.reasonTags.querySelectorAll('button[data-reason]').forEach((button) => {
    button.addEventListener('click', () => {
      const idValue = button.dataset.reason;
      state.data.reasons = state.data.reasons.filter((reason) => reason.id !== idValue);
      state.data.queue = state.data.queue.filter((entry) => entry.reasonId !== idValue);
      saveData();
      populateReasonOptions();
      renderReasonTags();
    });
  });
}

function renderCollegeTags() {
  if (!adminElements.collegeTags) return;
  const colleges = getAllColleges();
  adminElements.collegeTags.innerHTML = colleges
    .map((college) => {
      const removable = !BASE_COLLEGES.includes(college);
      return `<span class="tag">${college}${removable ? ` <button data-college="${college}">×</button>` : ''}</span>`;
    })
    .join('');

  adminElements.collegeTags.querySelectorAll('button[data-college]').forEach((button) => {
    button.addEventListener('click', () => {
      const label = button.dataset.college;
      state.data.colleges = state.data.colleges.filter((college) => college !== label);
      saveData();
      populateCollegeOptions();
      renderCollegeTags();
      updateCollegeDatalist();
    });
  });
}

function updateCollegeDatalist() {
  const datalist = id('college-options');
  if (!datalist) return;
  datalist.innerHTML = getAllColleges().map((college) => `<option value="${college}"></option>`).join('');
}

// Event subscriptions ---------------------------------------------------

function setupDataSubscriptions() {
  window.addEventListener('storage', (event) => {
    if (event.key === DATA_KEY) {
      const updated = loadData();
      if (updated) {
        state.data = updated;
        populateCollegeOptions();
        populateReasonOptions();
        if (state.currentAdvisor) {
          renderAdvisorQueue();
        }
        if (state.currentAdmin) {
          renderAdminDashboard();
        }
      }
    }
  });

  window.addEventListener('checkin-data-updated', () => {
    if (state.currentAdvisor) {
      renderAdvisorQueue();
    }
    if (state.currentAdmin) {
      renderAdminDashboard();
    }
  });
}

// Initialize ------------------------------------------------------------

async function init() {
  state.data = loadData();
  if (!state.data) {
    state.data = await createDefaultData();
    saveData();
  }

  setupTabs();
  setupStudentView();
  setupAdvisorView();
  setupAdminView();
  setupDataSubscriptions();
  renderAdminDashboard();
  updateCollegeDatalist();
}

init();
