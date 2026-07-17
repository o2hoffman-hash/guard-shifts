import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// Firebase config values are safe to embed in client code - they identify
// your project, they are not secret keys. Access control is enforced by
// Firestore Security Rules (console.firebase.google.com -> Firestore -> Rules).
const firebaseConfig = {
  apiKey: "AIzaSyDoTAEjIHYbK8O_BQ1JN6Gyot1UwFdagtg",
  authDomain: "guard-shifts-d2b37.firebaseapp.com",
  projectId: "guard-shifts-d2b37",
  storageBucket: "guard-shifts-d2b37.firebasestorage.app",
  messagingSenderId: "761794906695",
  appId: "1:761794906695:web:4973e831d56e6ee381ff62",
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
