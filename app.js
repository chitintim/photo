/* =============================================
   Photo Frame Web Portal — Application Logic
   ============================================= */

// =============================================
// Configuration
// =============================================
const SUPABASE_URL = 'https://wwpmmkudqeqpbtezfupa.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_QpD6vFCGJczK5S1VgweoOQ_ZZIVlKQB'; // TODO: Replace with your anon key from Supabase Dashboard → Settings → API

// =============================================
// State
// =============================================
let sb;                    // Supabase client
let currentUser = null;    // Auth user
let currentPair = null;    // { id, pair_code, created_at }
let pairUser = null;       // { id, pair_id, user_id, device_role, display_name }
let photos = [];           // Array of photo records
let currentPhotoIndex = 0;
let realtimeChannel = null;
let toastTimer = null;

// =============================================
// Initialize
// =============================================
async function init() {
    // Check if anon key is configured
    if (SUPABASE_ANON_KEY === 'YOUR_ANON_KEY_HERE') {
        document.getElementById('screen-loading').innerHTML = `
            <div class="screen-center">
                <div class="heart-icon">&hearts;</div>
                <h1>Setup Required</h1>
                <p class="subtitle">Edit <strong>app.js</strong> and replace YOUR_ANON_KEY_HERE with your Supabase anon key.</p>
                <p class="hint">Find it at: Supabase Dashboard &rarr; Settings &rarr; API &rarr; anon public</p>
            </div>
        `;
        return;
    }

    sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    // Check for existing session
    const { data: { session } } = await sb.auth.getSession();
    if (session) {
        currentUser = session.user;
        await loadPairInfo();
    } else {
        showScreen('auth');
    }

    // Listen for auth state changes
    sb.auth.onAuthStateChange((event, session) => {
        if (event === 'SIGNED_OUT') {
            currentUser = null;
            currentPair = null;
            pairUser = null;
            photos = [];
            if (realtimeChannel) {
                sb.removeChannel(realtimeChannel);
                realtimeChannel = null;
            }
            showScreen('auth');
        }
    });
}

// =============================================
// Screen Management
// =============================================
function showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
    const screen = document.getElementById('screen-' + name);
    if (screen) screen.classList.remove('hidden');
}

// =============================================
// Auth Functions
// =============================================
async function handleAuth(e) {
    e.preventDefault();
    const email = document.getElementById('auth-email').value.trim();
    const password = document.getElementById('auth-password').value;
    const isSignup = document.querySelector('.tab.active').dataset.tab === 'signup';
    const submitBtn = document.getElementById('auth-submit');

    submitBtn.disabled = true;
    submitBtn.textContent = isSignup ? 'Signing up...' : 'Logging in...';
    hideMessage('auth-message');

    try {
        if (isSignup) {
            const { data, error } = await sb.auth.signUp({ email, password });
            if (error) throw error;

            if (!data.session) {
                // Email confirmation required
                showMessage('auth-message', 'Check your email to confirm your account, then log in.', 'info');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Sign Up';
                return;
            }
            currentUser = data.user;
        } else {
            const { data, error } = await sb.auth.signInWithPassword({ email, password });
            if (error) throw error;
            currentUser = data.user;
        }

        await loadPairInfo();
    } catch (err) {
        showMessage('auth-message', err.message, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.textContent = isSignup ? 'Sign Up' : 'Log In';
    }
}

// =============================================
// Pair Functions
// =============================================
async function loadPairInfo() {
    showScreen('loading');

    try {
        // Check if user belongs to a pair
        const { data: pairUsers, error } = await sb
            .from('pair_users')
            .select('*, pairs(*)')
            .eq('user_id', currentUser.id);

        if (error) throw error;

        if (!pairUsers || pairUsers.length === 0) {
            showScreen('pair');
            return;
        }

        pairUser = pairUsers[0];
        currentPair = pairUsers[0].pairs;

        showScreen('dashboard');
        await loadDashboard();
    } catch (err) {
        console.error('loadPairInfo error:', err);
        showScreen('pair');
    }
}

async function createPair() {
    const displayName = document.getElementById('create-display-name').value.trim();
    if (!displayName) {
        showMessage('pair-message', 'Please enter a display name.', 'error');
        return;
    }

    const btn = document.getElementById('btn-create-pair');
    btn.disabled = true;
    btn.textContent = 'Creating...';
    hideMessage('pair-message');

    try {
        const code = generatePairCode();

        // Insert pair
        const { data: pair, error: pairErr } = await sb
            .from('pairs')
            .insert({ pair_code: code })
            .select()
            .single();

        if (pairErr) throw pairErr;

        // Insert pair_users (must come before pair_state for RLS)
        const { error: userErr } = await sb
            .from('pair_users')
            .insert({
                pair_id: pair.id,
                user_id: currentUser.id,
                device_role: 'A',
                display_name: displayName
            });

        if (userErr) throw userErr;

        // Insert pair_state
        const { error: stateErr } = await sb
            .from('pair_state')
            .insert({ pair_id: pair.id });

        if (stateErr) console.warn('pair_state insert warning:', stateErr);

        // Show the generated code
        document.getElementById('generated-code').textContent = code;
        document.getElementById('pair-code-display').classList.remove('hidden');
        document.getElementById('pair-create-section').classList.add('hidden');

        currentPair = pair;
    } catch (err) {
        showMessage('pair-message', err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Create Pair';
    }
}

async function joinPair() {
    const code = document.getElementById('join-code').value.trim().toUpperCase();
    const displayName = document.getElementById('join-display-name').value.trim();

    if (!code) {
        showMessage('pair-message', 'Please enter a pair code.', 'error');
        return;
    }
    if (!displayName) {
        showMessage('pair-message', 'Please enter a display name.', 'error');
        return;
    }

    const btn = document.getElementById('btn-join-pair');
    btn.disabled = true;
    btn.textContent = 'Joining...';
    hideMessage('pair-message');

    try {
        // Look up pair by code using the SECURITY DEFINER function
        const { data: pairId, error: lookupErr } = await sb.rpc('get_pair_id_by_code', { code });

        if (lookupErr || !pairId) {
            throw new Error('Invalid pair code. Please check and try again.');
        }

        // Join as device B
        const { error: joinErr } = await sb
            .from('pair_users')
            .insert({
                pair_id: pairId,
                user_id: currentUser.id,
                device_role: 'B',
                display_name: displayName
            });

        if (joinErr) throw joinErr;

        await loadPairInfo();
    } catch (err) {
        showMessage('pair-message', err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Join Pair';
    }
}

function generatePairCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0/O, 1/I/L)
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// =============================================
// Dashboard
// =============================================
async function loadDashboard() {
    document.getElementById('dash-pair-code').textContent = currentPair.pair_code;
    await loadPhotos();
    setupRealtime();
}

// =============================================
// Photos
// =============================================
async function loadPhotos() {
    const { data, error } = await sb
        .from('photos')
        .select('*')
        .eq('pair_id', currentPair.id)
        .order('display_order', { ascending: true });

    if (error) {
        console.error('Load photos error:', error);
        return;
    }

    photos = data || [];

    // Clamp currentPhotoIndex
    if (currentPhotoIndex >= photos.length) {
        currentPhotoIndex = Math.max(0, photos.length - 1);
    }

    renderPhotoGallery();
    updatePhotoNav();
}

function renderPhotoGallery() {
    const gallery = document.getElementById('photo-gallery');
    const empty = document.getElementById('gallery-empty');

    // Clear gallery but preserve the empty placeholder
    gallery.innerHTML = '';

    if (photos.length === 0) {
        gallery.appendChild(empty);
        empty.classList.remove('hidden');
        return;
    }

    empty.classList.add('hidden');

    photos.forEach((photo, index) => {
        const url = SUPABASE_URL + '/storage/v1/object/public/photos/' + photo.storage_path;
        const div = document.createElement('div');
        div.className = 'gallery-item' + (index === currentPhotoIndex ? ' active' : '');
        const img = document.createElement('img');
        img.src = url;
        img.alt = photo.filename;
        img.loading = 'lazy';
        div.appendChild(img);
        div.addEventListener('click', function () { openLightbox(index); });
        gallery.appendChild(div);
    });
}

function isHeicFile(file) {
    var name = (file.name || '').toLowerCase();
    if (name.endsWith('.heic') || name.endsWith('.heif')) return true;
    var type = (file.type || '').toLowerCase();
    return type === 'image/heic' || type === 'image/heif';
}

async function convertHeicToJpeg(file) {
    if (typeof HeicTo !== 'function') {
        throw new Error('HEIC converter not loaded. Please refresh and try again.');
    }
    var jpegBlob = await HeicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
    return jpegBlob;
}

async function uploadPhotos(files) {
    if (!files || files.length === 0) return;

    const progressEl = document.getElementById('upload-progress');
    const statusEl = document.getElementById('upload-status');
    const fillEl = document.getElementById('progress-fill');

    progressEl.classList.remove('hidden');
    fillEl.style.width = '0%';

    let uploaded = 0;

    for (let i = 0; i < files.length; i++) {
        try {
            var file = files[i];

            // Convert HEIC/HEIF to JPEG first (iPhones use HEIC by default)
            if (isHeicFile(file)) {
                statusEl.textContent = 'Converting HEIC ' + (i + 1) + ' of ' + files.length + '...';
                fillEl.style.width = ((i / files.length) * 100) + '%';
                file = await convertHeicToJpeg(file);
            }

            statusEl.textContent = 'Resizing ' + (i + 1) + ' of ' + files.length + '...';
            fillEl.style.width = ((i / files.length) * 100) + '%';

            // Resize image to 240x320 JPEG
            const blob = await resizeImage(file);

            statusEl.textContent = 'Uploading ' + (i + 1) + ' of ' + files.length + '...';

            // Upload to Supabase Storage
            const filename = Date.now() + '_' + i + '.jpg';
            const storagePath = currentPair.id + '/' + filename;

            const { error: uploadErr } = await sb.storage
                .from('photos')
                .upload(storagePath, blob, { contentType: 'image/jpeg' });

            if (uploadErr) {
                console.error('Upload error:', uploadErr);
                continue;
            }

            // Insert photo record
            const { error: insertErr } = await sb
                .from('photos')
                .insert({
                    pair_id: currentPair.id,
                    storage_path: storagePath,
                    filename: filename,
                    display_order: photos.length + i,
                    uploaded_by: currentUser.id
                });

            if (insertErr) {
                console.error('Insert error:', insertErr);
                continue;
            }

            uploaded++;
        } catch (err) {
            console.error('Error processing file ' + i + ':', err);
            showToast('Failed to process ' + (files[i].name || 'file') + ': ' + err.message);
        }

        fillEl.style.width = (((i + 1) / files.length) * 100) + '%';
    }

    statusEl.textContent = 'Done!';
    setTimeout(function () { progressEl.classList.add('hidden'); }, 1500);

    await loadPhotos();
    if (uploaded > 0) {
        showToast(uploaded + ' photo' + (uploaded > 1 ? 's' : '') + ' uploaded!');
    }
}

function resizeImage(file) {
    return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () {
            var canvas = document.createElement('canvas');
            canvas.width = 240;
            canvas.height = 320;
            var ctx = canvas.getContext('2d');

            // Center-crop to fill 240x320 (3:4 portrait)
            var targetRatio = 240 / 320;
            var imgRatio = img.width / img.height;
            var sx, sy, sw, sh;

            if (imgRatio > targetRatio) {
                // Source image is wider — crop sides
                sh = img.height;
                sw = img.height * targetRatio;
                sx = (img.width - sw) / 2;
                sy = 0;
            } else {
                // Source image is taller — crop top/bottom
                sw = img.width;
                sh = img.width / targetRatio;
                sx = 0;
                sy = (img.height - sh) / 2;
            }

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, sx, sy, sw, sh, 0, 0, 240, 320);

            canvas.toBlob(function (blob) {
                URL.revokeObjectURL(img.src);
                if (blob) {
                    resolve(blob);
                } else {
                    reject(new Error('Failed to create JPEG blob'));
                }
            }, 'image/jpeg', 0.85);
        };
        img.onerror = function () {
            URL.revokeObjectURL(img.src);
            reject(new Error('Failed to load image'));
        };
        img.src = URL.createObjectURL(file);
    });
}

async function deletePhoto(index) {
    if (index < 0 || index >= photos.length) return;
    if (!confirm('Delete this photo from both frames?')) return;

    var photo = photos[index];

    try {
        // Delete from storage
        await sb.storage.from('photos').remove([photo.storage_path]);

        // Delete from database
        await sb.from('photos').delete().eq('id', photo.id);

        closeLightbox();
        await loadPhotos();
        showToast('Photo deleted');
    } catch (err) {
        console.error('Delete error:', err);
        showToast('Failed to delete photo');
    }
}

// =============================================
// Photo Navigation
// =============================================
function updatePhotoNav() {
    var counter = document.getElementById('photo-counter');
    counter.textContent = photos.length > 0
        ? (currentPhotoIndex + 1) + ' / ' + photos.length
        : '0 / 0';
}

async function navigatePhoto(direction) {
    if (photos.length === 0) return;

    if (direction === 'next') {
        currentPhotoIndex = (currentPhotoIndex + 1) % photos.length;
    } else {
        currentPhotoIndex = (currentPhotoIndex - 1 + photos.length) % photos.length;
    }

    updatePhotoNav();
    renderPhotoGallery();

    // Send navigation event so ESP32 devices sync
    await sendEvent('photo_nav', { index: currentPhotoIndex });
}

// =============================================
// Messages & Emojis
// =============================================
async function sendMessage() {
    var input = document.getElementById('message-text');
    var text = input.value.trim();
    if (!text) return;

    var btn = document.getElementById('btn-send-message');
    btn.disabled = true;

    await sendEvent('message', {
        text: text,
        sender_label: pairUser.display_name
    });

    input.value = '';
    btn.disabled = false;
    showToast('Message sent!');
    addActivity('message', 'You: ' + text);
}

async function sendEmoji(emoji, buttonEl) {
    // Random position within the photo display area
    var x = Math.floor(Math.random() * 200) + 20;
    var y = Math.floor(Math.random() * 240) + 20;

    // Button animation
    if (buttonEl) {
        buttonEl.classList.add('sent');
        setTimeout(function () { buttonEl.classList.remove('sent'); }, 400);
    }

    await sendEvent('emoji', { emoji: emoji, x: x, y: y });
    addActivity('emoji', 'You sent ' + emojiToDisplay(emoji));
}

async function sendEvent(eventType, payload) {
    if (!currentPair || !pairUser) return;

    try {
        var { error } = await sb.from('events').insert({
            pair_id: currentPair.id,
            sender: pairUser.device_role,
            event_type: eventType,
            payload: payload
        });

        if (error) {
            console.error('Send event error:', error);
            showToast('Failed to send — check connection');
        }
    } catch (err) {
        console.error('Send event error:', err);
    }
}

function emojiToDisplay(emoji) {
    var map = {
        heart: '\u2764\uFE0F',
        pink_heart: '\uD83D\uDC97',
        sparkle_heart: '\uD83D\uDC96',
        stars: '\u2728'
    };
    return map[emoji] || emoji;
}

// =============================================
// Realtime Subscriptions
// =============================================
function setupRealtime() {
    if (realtimeChannel) {
        sb.removeChannel(realtimeChannel);
    }

    realtimeChannel = sb
        .channel('pair-sync-' + currentPair.id)
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'events',
            filter: 'pair_id=eq.' + currentPair.id
        }, function (payload) {
            var event = payload.new;
            // Skip events from self
            if (event.sender === pairUser.device_role) return;
            handleIncomingEvent(event);
        })
        .on('postgres_changes', {
            event: 'INSERT',
            schema: 'public',
            table: 'photos',
            filter: 'pair_id=eq.' + currentPair.id
        }, function () {
            // Reload photos when other device uploads
            loadPhotos();
        })
        .on('postgres_changes', {
            event: 'DELETE',
            schema: 'public',
            table: 'photos',
            filter: 'pair_id=eq.' + currentPair.id
        }, function () {
            loadPhotos();
        })
        .subscribe(function (status) {
            if (status === 'SUBSCRIBED') {
                console.log('Realtime connected');
            }
        });
}

function handleIncomingEvent(event) {
    var payload = event.payload || {};

    switch (event.event_type) {
        case 'emoji':
            showToast(emojiToDisplay(payload.emoji) + ' received!');
            addActivity('emoji', 'Received ' + emojiToDisplay(payload.emoji));
            break;
        case 'message':
            showToast('\uD83D\uDCAC ' + (payload.text || '...'));
            addActivity('message', 'Message: ' + (payload.text || '...'));
            break;
        case 'photo_nav':
            if (payload.index !== undefined && payload.index < photos.length) {
                currentPhotoIndex = payload.index;
                updatePhotoNav();
                renderPhotoGallery();
                addActivity('nav', 'Other device navigated to photo ' + (payload.index + 1));
            }
            break;
    }
}

// =============================================
// Activity Feed
// =============================================
function addActivity(type, text) {
    var feed = document.getElementById('activity-feed');
    var empty = document.getElementById('activity-empty');

    if (empty) empty.classList.add('hidden');

    var item = document.createElement('div');
    item.className = 'activity-item';

    var now = new Date();
    var time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    item.innerHTML = '<span class="activity-time">' + time + '</span> ' + escapeHtml(text);
    feed.insertBefore(item, feed.firstChild);

    // Keep max 20 items
    while (feed.children.length > 21) { // 20 items + possibly the hidden empty element
        feed.removeChild(feed.lastChild);
    }
}

// =============================================
// Lightbox
// =============================================
var lightboxPhotoIndex = -1;

function openLightbox(index) {
    lightboxPhotoIndex = index;
    var photo = photos[index];
    var url = SUPABASE_URL + '/storage/v1/object/public/photos/' + photo.storage_path;
    document.getElementById('lightbox-img').src = url;
    document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
    document.getElementById('lightbox').classList.add('hidden');
    document.getElementById('lightbox-img').src = '';
    lightboxPhotoIndex = -1;
}

// =============================================
// UI Helpers
// =============================================
function showMessage(elementId, message, type) {
    var el = document.getElementById(elementId);
    el.textContent = message;
    el.className = 'message-box ' + type;
    el.classList.remove('hidden');
}

function hideMessage(elementId) {
    document.getElementById(elementId).classList.add('hidden');
}

function showToast(message) {
    var toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.remove('hidden');

    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
        toast.classList.add('hidden');
    }, 3000);
}

function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// =============================================
// Event Listeners
// =============================================
document.addEventListener('DOMContentLoaded', function () {

    // --- Auth ---
    document.getElementById('auth-form').addEventListener('submit', handleAuth);

    // Auth tab switching
    document.querySelectorAll('.tab').forEach(function (tab) {
        tab.addEventListener('click', function () {
            document.querySelectorAll('.tab').forEach(function (t) { t.classList.remove('active'); });
            tab.classList.add('active');
            var submitBtn = document.getElementById('auth-submit');
            submitBtn.textContent = tab.dataset.tab === 'signup' ? 'Sign Up' : 'Log In';
            // Switch autocomplete hint for password field
            var pwField = document.getElementById('auth-password');
            pwField.autocomplete = tab.dataset.tab === 'signup' ? 'new-password' : 'current-password';
        });
    });

    // --- Pair Setup ---
    document.getElementById('btn-create-pair').addEventListener('click', createPair);
    document.getElementById('btn-join-pair').addEventListener('click', joinPair);
    document.getElementById('btn-logout-pair').addEventListener('click', function () {
        sb.auth.signOut();
    });
    document.getElementById('btn-go-dashboard').addEventListener('click', function () {
        loadPairInfo();
    });

    // --- Dashboard ---
    document.getElementById('btn-logout').addEventListener('click', function () {
        if (realtimeChannel) sb.removeChannel(realtimeChannel);
        sb.auth.signOut();
    });

    // Photo upload
    document.getElementById('file-input').addEventListener('change', function (e) {
        if (e.target.files.length > 0) {
            uploadPhotos(Array.from(e.target.files));
            e.target.value = ''; // Reset so same file can be re-selected
        }
    });

    // Photo navigation
    document.getElementById('btn-prev').addEventListener('click', function () { navigatePhoto('prev'); });
    document.getElementById('btn-next').addEventListener('click', function () { navigatePhoto('next'); });

    // Messages
    document.getElementById('btn-send-message').addEventListener('click', sendMessage);
    document.getElementById('message-text').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') sendMessage();
    });

    // Emojis
    document.querySelectorAll('.emoji-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
            sendEmoji(btn.dataset.emoji, btn);
        });
    });

    // Lightbox
    document.getElementById('btn-lightbox-close').addEventListener('click', closeLightbox);
    document.getElementById('btn-lightbox-delete').addEventListener('click', function () {
        if (lightboxPhotoIndex >= 0) deletePhoto(lightboxPhotoIndex);
    });
    document.getElementById('lightbox').addEventListener('click', function (e) {
        if (e.target === document.getElementById('lightbox')) closeLightbox();
    });

    // --- Initialize ---
    init();
});
