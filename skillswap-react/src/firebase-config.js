// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { getFunctions } from 'firebase/functions';

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "dummy-key",
  authDomain: "dummy-domain",
  projectId: "dummy-project-id",
  storageBucket: "dummy-bucket",
  messagingSenderId: "dummy-sender-id",
  appId: "dummy-app-id"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const firestore = getFirestore(app);
export const functions = getFunctions(app);
