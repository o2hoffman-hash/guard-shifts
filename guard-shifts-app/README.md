# משמרות שמירה

## הרצה מקומית (אופציונלי, לפני פריסה)
```
npm install
npm run dev
```

## פריסה ל-Vercel (הדרך המומלצת)

1. גלוש ל: **vercel.com** והתחבר עם חשבון Google/GitHub
2. הדרך הכי פשוטה בלי Git: לחץ על **"Add New" → "Project"**, ואז גרור את כל תיקיית הפרויקט הזו (או השתמש באפשרות ה-drag & drop של Vercel)
   - אם יש לך GitHub: אפשר גם להעלות את התיקייה כ-repository ואז לחבר אותו ל-Vercel - זה נותן עדכונים אוטומטיים בעתיד
3. Vercel יזהה אוטומטית שזה פרויקט **Vite** - השאר את ההגדרות כברירת מחדל:
   - Build Command: `npm run build`
   - Output Directory: `dist`
4. לחץ **Deploy**
5. תוך דקה-שתיים תקבל קישור כמו `guard-shifts.vercel.app` - זה הקישור להפצה!

## חשוב - אחרי שהכל עובד: לסגור את כללי האבטחה ב-Firestore

כרגע ה-Firestore רץ במצב "test mode" שנותן גישה פתוחה לכולם (גם למי שלא באפליקציה). 
לפני שמפיצים את הקישור בפועל, כנס ל:

**Firebase Console → Firestore Database → Rules**

והחלף לכללים הבאים (מאפשרים קריאה/כתיבה רק למסמך היחיד שהאפליקציה משתמשת בו):

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /app/state {
      allow read, write: if true;
    }
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

זה עדיין לא מצריך התחברות אמיתית (בהתאם למה שביקשת - בלי תהליך זיהוי מסובך), אבל חוסם גישה לכל שאר מסד הנתונים שלך מלבד המסמך הזה.
