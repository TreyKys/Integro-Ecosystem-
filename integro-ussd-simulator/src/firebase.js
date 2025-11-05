// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";
import { getFirestore } from "firebase/firestore";

// Your web app's Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBjS8gfZMynr8kdeodC61b0X37GJevHy_E",
  authDomain: "integro-ecosystem.firebaseapp.com",
  projectId: "integro-ecosystem",
  storageBucket: "integro-ecosystem.appspot.com", // Corrected storage bucket domain
  messagingSenderId: "285529185485",
  appId: "1:285529185485:web:7cfe295b71e13d5b789d84",
  measurementId: "G-42CZ3J0DDN"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const functions = getFunctions(app);
const db = getFirestore(app);

// Create references to the callable functions
const createAccount = httpsCallable(functions, 'createAccount');
const mintRWAviaUSSD = httpsCallable(functions, 'mintRWAviaUSSD');
const executeNativeNftTransfer = httpsCallable(functions, 'executeNativeNftTransfer');
const setUserProfile = httpsCallable(functions, 'setUserProfile');


export {
  db,
  createAccount,
  mintRWAviaUSSD,
  executeNativeNftTransfer,
  setUserProfile
};
