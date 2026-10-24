
const $ = id => document.getElementById(id);
const socket = io();

const remoteVideo = $("remoteVideo");
const localVideo = $("localVideo");
const remotePlaceholder = $("remotePlaceholder");

const findBtn = $("findBtn");
const nextBtn = $("nextBtn");
const endBtn = $("endBtn");
const micBtn = $("micBtn");
const cameraBtn = $("cameraBtn");
const switchCameraBtn = $("switchCameraBtn");
const chatForm = $("chatForm");
const chatInput = $("chatInput");
const chatMessages = $("chatMessages");
const reportBtn = $("reportBtn");
const blockBtn = $("blockBtn");

let localStream = null;
let peer = null;
let peerId = null;
let searching = false;
let inCall = false;
let micOn = true;
let cameraOn = true;
let facingMode = "user";
let timerInterval = null;
let callStartedAt = 0;
let pendingCandidates = [];
let callGeneration = 0;
let switchingCamera = false;

const flags = {
  PK: "🇵🇰", IN: "🇮🇳", US: "🇺🇸",
  GB: "🇬🇧", CA: "🇨🇦", AE: "🇦🇪",
  SA: "🇸🇦", TR: "🇹🇷", BD: "🇧🇩",
  OTHER: "🌍"
};

function status(title, detail) {
  $("status").textContent = title;
  $("detail").textContent = detail;
}

function connectionState(text, online) {
  $("connection").textContent = text;
  $("connectionDot").classList.toggle("online", online);
}

function updateButtons() {
  findBtn.disabled = searching || inCall || !socket.connected;
  nextBtn.disabled = !inCall && !searching;
  endBtn.disabled = !inCall && !searching;

  micBtn.disabled = !localStream;
  cameraBtn.disabled = !localStream;
  switchCameraBtn.disabled = !localStream || switchingCamera;

  chatInput.disabled = !inCall;
  $("sendBtn").disabled = !inCall;
  reportBtn.disabled = !inCall;
  blockBtn.disabled = !inCall;
}

function showPlaceholder(title, detail) {
  remoteVideo.style.display = "none";
  remoteVideo.srcObject = null;
  remotePlaceholder.classList.remove("hidden");
  $("placeholderTitle").textContent = title;
  $("placeholderText").textContent = detail;
}

function clearChat(message = "Connect to someone before sending a message.") {
  chatMessages.replaceChildren();

  const note = document.createElement("p");
  note.className = "chat-note";
  note.textContent = message;
  chatMessages.appendChild(note);
}

function addMessage(text, mine = false, time = Date.now()) {
  const note = chatMessages.querySelector(".chat-note");
  if (note) note.remove();

  const bubble = document.createElement("div");
  bubble.className = "message" + (mine ? " mine" : "");

  const content = document.createElement("span");
  content.textContent = text;

  const timestamp = document.createElement("small");
  timestamp.textContent = new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit"
  });

  bubble.append(content, timestamp);
  chatMessages.appendChild(bubble);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function startTimer() {
  clearInterval(timerInterval);
  callStartedAt = Date.now();

  timerInterval = setInterval(() => {
    const seconds = Math.floor((Date.now() - callStartedAt) / 1000);

    $("callTimer").textContent =
      String(Math.floor(seconds / 60)).padStart(2, "0") +
      ":" +
      String(seconds % 60).padStart(2, "0");
  }, 1000);
}

function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  $("callTimer").textContent = "00:00";
}

function updateMediaButtons() {
  micBtn.textContent = micOn ? "Mute mic" : "Unmute mic";
  cameraBtn.textContent = cameraOn ? "Turn camera off" : "Turn camera on";
  $("localCameraOff").classList.toggle("hidden", cameraOn);
}

async function getMedia() {
  if (
    localStream &&
    localStream.getTracks().some(track => track.readyState === "live")
  ) {
    return localStream;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Camera needs HTTPS or localhost.");
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: {
      facingMode: { ideal: facingMode },
      width: { ideal: 640 },
      height: { ideal: 480 }
    }
  });

  localVideo.srcObject = localStream;
  micOn = true;
  cameraOn = true;

  updateMediaButtons();
  updateButtons();

  return localStream;
}

function createPeer(generation) {
  if (peer) peer.close();

  pendingCandidates = [];

  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" }
    ]
  });

  peer = pc;

  localStream.getTracks().forEach(track => {
    pc.addTrack(track, localStream);
  });

  pc.ontrack = event => {
    if (generation !== callGeneration) return;

    const stream = event.streams[0];
    if (!stream) return;

    remoteVideo.srcObject = stream;
    remoteVideo.style.display = "block";
    remotePlaceholder.classList.add("hidden");
    remoteVideo.play().catch(() => {});
  };

  pc.onicecandidate = event => {
    if (event.candidate && generation === callGeneration) {
      socket.emit("ice_candidate", {
        candidate: event.candidate
      });
    }
  };

  pc.onconnectionstatechange = () => {
    if (generation !== callGeneration || peer !== pc) return;

    if (pc.connectionState === "connected") {
      status("Connected!", "You are talking to a random user.");
      startTimer();
    } else if (pc.connectionState === "connecting") {
      status("Connecting call...", "Please wait.");
    } else if (pc.connectionState === "failed") {
      stopTimer();
      status("Connection failed", "Try Next to find another user.");
    } else if (pc.connectionState === "disconnected") {
      status("Connection interrupted", "Waiting for connection recovery.");
    }
  };

  return pc;
}

async function startSearch() {
  if (inCall || searching) return;

  if (!socket.connected) {
    status("Server unavailable", "Reconnect and try again.");
    return;
  }

  try {
    status("Preparing camera...", "Allow camera and microphone access.");
    await getMedia();

    if (!socket.connected) {
      throw new Error("Server connection lost. Try again.");
    }

    callGeneration++;
    searching = true;
    inCall = false;
    peerId = null;

    showPlaceholder("Finding someone...", "Searching for a compatible user.");
    clearChat("Waiting for a match...");
    status("Finding someone...", "Keep this page open.");
    updateButtons();

    socket.emit("find", {
      gender: $("gender").value,
      genderPref: $("genderPref").value,
      country: $("country").value,
      countryPref: $("countryPref").value
    });
  } catch (error) {
    searching = false;
    status("Unable to start", error.message || "Check camera permissions.");
    updateButtons();
  }
}

async function setupCall(initiator) {
  if (!localStream || !peerId || !searching) return;

  const generation = callGeneration;

  searching = false;
  inCall = true;

  const pc = createPeer(generation);

  status("Connecting call...", "Setting up video connection.");
  updateButtons();

  if (initiator) {
    try {
      const offer = await pc.createOffer();

      if (generation !== callGeneration || peer !== pc) return;

      await pc.setLocalDescription(offer);

      socket.emit("webrtc_offer", {
        description: pc.localDescription
      });
    } catch (error) {
      status("Could not start call", error.message);
    }
  }
}

async function endCurrent(sendSignal = true, customTitle = null) {
  if (sendSignal && socket.connected) {
    socket.emit("leave_match");
  }

  callGeneration++;
  searching = false;
  inCall = false;
  peerId = null;
  pendingCandidates = [];

  if (peer) {
    peer.ontrack = null;
    peer.onicecandidate = null;
    peer.close();
    peer = null;
  }

  stopTimer();

  showPlaceholder(
    "Your next conversation awaits",
    "Start a random call to find someone."
  );

  $("guestLabel").textContent = "Random guest";
  clearChat();

  status(
    customTitle || "Ready to meet someone?",
    customTitle
      ? "You can search for another user."
      : "Press Start random call whenever you are ready."
  );

  updateButtons();
}

socket.on("connect", () => {
  connectionState("Online", true);
  updateButtons();
});

socket.on("disconnect", () => {
  connectionState("Offline", false);
  endCurrent(false, "Connection lost");
  status("Connection lost", "Reconnect to the server and try again.");
});

socket.on("connected", () => {
  connectionState("Online", true);
});

socket.on("searching", () => {
  status("Looking for a match...", "Waiting for a compatible user.");
});

socket.on("match_found", data => {
  peerId = data.peer;
  searching = true;

  const flag = flags[data.country] || "🌍";
  $("guestLabel").textContent = flag + " Random guest";

  status("User found!", "Connecting automatically...");
});

socket.on("call_ready", async data => {
  try {
    await setupCall(Boolean(data.initiator));
  } catch (error) {
    status("Call setup failed", error.message);
  }
});

socket.on("webrtc_offer", async data => {
  const pc = peer;
  const generation = callGeneration;

  if (!pc || !data?.description) return;

  try {
    await pc.setRemoteDescription(data.description);

    if (generation !== callGeneration || peer !== pc) return;

    for (const candidate of pendingCandidates) {
      await pc.addIceCandidate(candidate);
    }

    pendingCandidates = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    if (generation !== callGeneration || peer !== pc) return;

    socket.emit("webrtc_answer", {
      description: pc.localDescription
    });
  } catch (error) {
    status("Call error", error.message);
  }
});

socket.on("webrtc_answer", async data => {
  const pc = peer;

  if (!pc || !data?.description) return;

  try {
    await pc.setRemoteDescription(data.description);

    for (const candidate of pendingCandidates) {
      await pc.addIceCandidate(candidate);
    }

    pendingCandidates = [];
  } catch (error) {
    status("Could not finish connection", error.message);
  }
});

socket.on("ice_candidate", async data => {
  const pc = peer;
  if (!pc || !data?.candidate) return;

  try {
    const candidate = new RTCIceCandidate(data.candidate);

    if (pc.remoteDescription) {
      await pc.addIceCandidate(candidate);
    } else {
      pendingCandidates.push(candidate);
    }
  } catch (error) {
    console.warn("ICE candidate error:", error);
  }
});

socket.on("chat_message", data => {
  if (inCall && typeof data?.text === "string") {
    addMessage(data.text, false, data.time);
  }
});

chatForm.addEventListener("submit", event => {
  event.preventDefault();

  const text = chatInput.value.trim();

  if (!text || !inCall || !socket.connected) return;

  socket.emit("chat_message", { text });
  addMessage(text, true);

  chatInput.value = "";
});

socket.on("partner_left", data => {
  const message = data?.reason === "blocked"
    ? "The other user disconnected."
    : data?.reason === "reported"
      ? "The other user disconnected."
      : "Your conversation ended.";

  endCurrent(false, "User disconnected");
  status("Conversation ended", message);
});

socket.on("match_cancelled", data => {
  if (data?.reason === "blocked") {
    endCurrent(false, "User blocked");
  } else if (data?.reason === "reported") {
    endCurrent(false, "Report submitted");
  }
});

socket.on("report_received", () => {
  status("Report received", "Moderator follow-up is not configured yet.");
});

socket.on("block_success", () => {
  status("User blocked", "You have been disconnected.");
});

findBtn.addEventListener("click", startSearch);

nextBtn.addEventListener("click", async () => {
  await endCurrent(true);
  startSearch();
});

endBtn.addEventListener("click", () => {
  endCurrent(true);
});

micBtn.addEventListener("click", () => {
  if (!localStream) return;

  micOn = !micOn;

  localStream.getAudioTracks().forEach(track => {
    track.enabled = micOn;
  });

  updateMediaButtons();
});

cameraBtn.addEventListener("click", () => {
  if (!localStream) return;

  cameraOn = !cameraOn;

  localStream.getVideoTracks().forEach(track => {
    track.enabled = cameraOn;
  });

  updateMediaButtons();
});

// Improved Android camera flip.
switchCameraBtn.addEventListener("click", async () => {
  if (!localStream || switchingCamera) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    status("Camera unavailable", "Open the site using HTTPS or localhost.");
    return;
  }

  const oldTrack = localStream.getVideoTracks()[0];

  if (!oldTrack) {
    status("Camera unavailable", "No active camera track found.");
    return;
  }

  const oldFacing = facingMode;
  const nextFacing = oldFacing === "user" ? "environment" : "user";

  switchingCamera = true;
  updateButtons();

  let newStream = null;
  let oldTrackStopped = false;

  status("Switching camera...", "Please wait.");

  try {
    // Some Android phones need the current camera released first.
    oldTrack.stop();
    oldTrackStopped = true;

    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { exact: nextFacing },
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });
    } catch (firstError) {
      // Retry without exact constraint for less strict browsers.
      newStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: nextFacing },
          width: { ideal: 640 },
          height: { ideal: 480 }
        }
      });
    }

    const newTrack = newStream.getVideoTracks()[0];

    if (!newTrack) {
      throw new Error("The browser did not return a video track.");
    }

    if (peer) {
      const sender = peer.getSenders().find(
        item => item.track?.kind === "video"
      );

      if (sender) {
        await sender.replaceTrack(newTrack);
      }
    }

    // Keep the existing microphone track intact.
    localStream.removeTrack(oldTrack);
    localStream.addTrack(newTrack);

    localVideo.srcObject = localStream;
    facingMode = nextFacing;

    cameraOn = true;
    newTrack.enabled = true;

    updateMediaButtons();
    status(
      "Camera switched",
      nextFacing === "user" ? "Front camera active." : "Back camera active."
    );
  } catch (error) {
    console.error("Camera switch error:", error);

    // Restore the old camera if the new one could not be opened.
    if (oldTrackStopped) {
      try {
        const restoredStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: oldFacing } }
        });

        const restoredTrack = restoredStream.getVideoTracks()[0];

        if (restoredTrack) {
          if (peer) {
            const sender = peer.getSenders().find(
              item => item.track?.kind === "video"
            );

            if (sender) {
              await sender.replaceTrack(restoredTrack);
            }
          }

          localStream.removeTrack(oldTrack);
          localStream.addTrack(restoredTrack);
          localVideo.srcObject = localStream;
          facingMode = oldFacing;
          cameraOn = true;
          updateMediaButtons();
        }
      } catch (restoreError) {
        console.error("Camera restore error:", restoreError);
        status(
          "Camera unavailable",
          "Camera could not be reopened. End the call and allow camera access again."
        );
      }
    } else {
      status(
        "Camera switch unavailable",
        "Check browser camera permissions and try again."
      );
    }
  } finally {
    if (newStream) {
      newStream.getTracks().forEach(track => {
        if (!localStream?.getTracks().includes(track)) {
          track.stop();
        }
      });
    }

    switchingCamera = false;
    updateButtons();
  }
});

updateButtons();
