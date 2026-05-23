import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDYl792JM-8MLSqn_ismOecFbtA1tjH5-g",
  authDomain: "cerdas-bersama-b914e.firebaseapp.com",
  projectId: "cerdas-bersama-b914e",
  storageBucket: "cerdas-bersama-b914e.firebasestorage.app",
  messagingSenderId: "742743770113",
  appId: "1:742743770113:web:8109c06b77a37b5207ec00"
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
